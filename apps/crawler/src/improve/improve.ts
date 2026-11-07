import type { ClaudeClient } from "../claude";
import { detectType } from "../crawl/detect";
import { extractDocument, type CrawlResult } from "../crawl/run";
import { parseExtractionConfig, type ExtractionConfig } from "../extract/config";
import { htmlToText } from "../extract/html";
import type { RawEvent } from "../extract/types";
import { ensureActiveConfig, latestRawDocuments, type RawDocument } from "./configs";
import { decideAdoption, lostEvents, needsImprovement, newEvents, scoreExtraction, type QualityReport } from "./quality";

export { ensureActiveConfig, saveRawDocument, RAW_DOCS_PER_SOURCE } from "./configs";

export type ImproveDeps = { claude: ClaudeClient | null; now: () => Date };

export type ImproveResult = {
  sourceId: number;
  decision: "adopted" | "pending" | "rejected" | "skipped";
  reason: string;
  baseline?: QualityReport;
  candidate?: QualityReport;
  baselineConfigId?: number;
  candidateConfigId?: number;
};

/** 抽出設定で改善できる（= Claude で抽出している）手段 */
const IMPROVABLE_TYPES = new Set(["html", "llm"]);
/** Claude に渡す失敗サンプルの上限と、ページ本文の抜粋の長さ */
const MAX_SAMPLES = 10;
const EXCERPT_CHARS = 8000;

const SYSTEM = [
  "あなたは子供向けイベント情報の抽出パイプラインを改善する担当です。",
  "ある収集元のページから Claude でイベントを抽出していますが、日付・会場・対象年齢などの取得率が低くなっています。",
  "現在の抽出設定・取りこぼしたサンプル・ページ本文の抜粋を見て、抽出の精度を上げる新しい設定を提案してください。",
  "- instructions: このページの書式に合わせた、抽出担当への具体的な指示（どこに日付・会場・対象が書かれているか）",
  "- hints: 補足のヒント（箇条書き）",
  "- selectors: イベント一覧の部分だけを取り出す CSS セレクタの候補（自信がなければ空にする）",
  "ページに書かれていない情報を推測で補わせる指示や、イベントでないもの・子供向けでないもの（買い物のキャンペーン、大人向けの講座など）を含めさせる指示は書かないでください。",
].join("\n");

/** 新しく取れた項目がこれより多ければ、子供向けかを判定せずに人間の確認に回す */
const MAX_AUDIENCE_CHECK = 20;

const AUDIENCE_SYSTEM = [
  "あなたは子供向けイベント情報サイトの掲載可否を判定する担当です。",
  "各項目が、子供（乳幼児〜高校生）や親子が参加・利用するイベントかを判定してください。",
  "買い物のキャンペーン・プレゼント企画・SNS 企画・飲食メニューの紹介・大人だけが対象の講座は、子供向けではありません。",
  "対象が書かれていなくても、内容から子供や親子が参加できるイベントなら子供向けとしてください。",
].join("\n");

const AUDIENCE_TOOL = {
  name: "judge_audience",
  description: "各項目が子供向けのイベントかを判定する",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "項目の番号" },
            for_children: { type: "boolean", description: "子供や親子向けのイベントなら true" },
            reason: { type: "string", description: "判定の理由（30 文字程度）" },
          },
          required: ["index", "for_children", "reason"],
        },
      },
    },
    required: ["items"],
  },
};

/** 子供向けでないと判定された項目の数 */
export async function countOffTarget(events: RawEvent[], claude: ClaudeClient): Promise<number> {
  if (events.length === 0) return 0;
  const prompt = events
    .map((e, i) => `[${i}] ${e.title}${e.ageText ? ` / 対象: ${e.ageText}` : ""}${e.summary ? ` / ${e.summary}` : ""}`)
    .join("\n");
  const out = (await claude.callTool({ system: AUDIENCE_SYSTEM, prompt, tool: AUDIENCE_TOOL })) as {
    items?: { index?: number; for_children?: boolean }[];
  } | null;
  const judged = new Map((out?.items ?? []).map((it) => [it.index, it.for_children]));
  return events.filter((_, i) => judged.get(i) !== true).length;
}

const TOOL = {
  name: "propose_extraction_config",
  description: "改善した抽出設定を提案する",
  inputSchema: {
    type: "object",
    properties: {
      instructions: { type: "string", description: "このページ向けの抽出の指示" },
      hints: { type: "array", items: { type: "string" }, description: "補足のヒント" },
      selectors: { type: "array", items: { type: "string" }, description: "本文を絞る CSS セレクタの候補" },
      reason: { type: "string", description: "何が問題で、どう変えたか（100 文字程度）" },
    },
    required: ["instructions", "reason"],
  },
};

type SourceInfo = { id: number; url: string; type: string; prefecture: string };

type Evaluation = { report: QualityReport; raws: RawEvent[] };

/** 保存済みの生データに対して、ある設定で再抽出して採点する */
async function evaluate(source: SourceInfo, docs: RawDocument[], config: ExtractionConfig, claude: ClaudeClient): Promise<Evaluation> {
  const raws: RawEvent[] = [];
  for (const doc of docs) {
    const detected = detectType({ contentType: doc.contentType, url: doc.url, body: doc.body });
    const out = await extractDocument(doc.body, doc.url, detected, source.type, claude, config, new Date(doc.fetchedAt));
    raws.push(...out.raws);
  }
  // 年の補完は最新の取得日時を基準にする（保存しているのは直近数回分なので差は小さい）
  const referenceDate = new Date(docs[0]!.fetchedAt);
  return { report: scoreExtraction(raws, { prefecture: source.prefecture, sourceUrl: source.url, referenceDate }), raws };
}

/** 日付・会場・年齢のどれかが取れなかったサンプル */
function failedSamples(raws: RawEvent[], source: SourceInfo, referenceDate: Date): RawEvent[] {
  const missing = raws.filter((r) => {
    const one = scoreExtraction([r], { prefecture: source.prefecture, sourceUrl: source.url, referenceDate });
    return one.dateRate < 1 || one.venueRate < 1 || one.ageRate < 1;
  });
  return missing.slice(0, MAX_SAMPLES);
}

function proposalPrompt(current: ExtractionConfig, report: QualityReport, samples: RawEvent[], doc: RawDocument): string {
  const sample = samples.map((r) => ({ title: r.title, date_text: r.dateText ?? r.start ?? null, venue: r.venue ?? null, age_text: r.ageText ?? null }));
  return [
    `ページの URL: ${doc.url}`,
    "",
    "--- 現在の抽出設定（JSON。空なら既定のプロンプトのみ）---",
    JSON.stringify(current, null, 2),
    "",
    "--- 現在の品質指標（0〜1）---",
    JSON.stringify(report),
    "",
    "--- 取りこぼしたサンプル（抽出結果）---",
    JSON.stringify(sample, null, 2),
    "",
    "--- ページ本文（テキストの抜粋）---",
    htmlToText(doc.body).slice(0, EXCERPT_CHARS),
  ].join("\n");
}

/**
 * 1 つの収集元について、改善案の作成 → 保存データでの検証 → 採否 を行う。
 * はっきり良くなった場合だけ新しい版を active にする。微妙な改善は candidate のまま残して人間の確認（pending）に回す。
 * 前後比較は config_evaluations に残す
 */
export async function improveSource(db: D1Database, sourceId: number, deps: ImproveDeps): Promise<ImproveResult> {
  const skip = (reason: string): ImproveResult => ({ sourceId, decision: "skipped", reason });
  const claude = deps.claude;
  if (!claude) return skip("Claude API がないため改善できません（ANTHROPIC_API_KEY 未設定）");
  const source = await db.prepare("SELECT id, url, type, prefecture FROM sources WHERE id = ?").bind(sourceId).first<SourceInfo>();
  if (!source) return skip("収集元がありません");
  const docs = await latestRawDocuments(db, sourceId);
  if (docs.length === 0) return skip("検証に使う生データがありません");

  const now = deps.now();
  const active = await ensureActiveConfig(db, sourceId, now);

  let baseline: Evaluation;
  let proposal: { config: ExtractionConfig; reason: string };
  try {
    baseline = await evaluate(source, docs, active.config, claude);
    const samples = failedSamples(baseline.raws, source, new Date(docs[0]!.fetchedAt));
    const out = (await claude.callTool({
      system: SYSTEM,
      prompt: proposalPrompt(active.config, baseline.report, samples, docs[0]!),
      tool: TOOL,
    })) as Record<string, unknown> | null;
    const config = parseExtractionConfig(out);
    if (Object.keys(config).length === 0) return skip("Claude の改善案から設定を読めませんでした");
    const reason = typeof out?.reason === "string" && out.reason.trim() ? out.reason.trim() : "（理由の記載なし）";
    proposal = { config, reason };
  } catch (e) {
    return skip(`改善案を作れませんでした（${e instanceof Error ? e.message : String(e)}）`);
  }

  const created = await db
    .prepare(
      `INSERT INTO extraction_configs (source_id, version, config, status, parent_config_id, note)
       SELECT ?, max(version) + 1, ?, 'candidate', ?, ? FROM extraction_configs WHERE source_id = ? RETURNING id`,
    )
    .bind(sourceId, JSON.stringify(proposal.config), active.id, proposal.reason, sourceId)
    .first<{ id: number }>();
  const candidateId = created!.id;

  let candidate: Evaluation;
  try {
    candidate = await evaluate(source, docs, proposal.config, claude);
  } catch (e) {
    // 検証できなかった候補は採用しない。理由を残して rejected にする
    const reason = `検証に失敗しました（${e instanceof Error ? e.message : String(e)}）`;
    await db
      .prepare("UPDATE extraction_configs SET status = 'rejected', note = ? WHERE id = ?")
      .bind(`${proposal.reason}\n${reason}`, candidateId)
      .run();
    return { ...skip(reason), baseline: baseline.report, baselineConfigId: active.id, candidateConfigId: candidateId };
  }

  const referenceDate = new Date(docs[0]!.fetchedAt);
  const lost = lostEvents(baseline.raws, candidate.raws, { prefecture: source.prefecture, sourceUrl: source.url, referenceDate });
  let decision = decideAdoption(baseline.report, candidate.report, { lost });
  if (decision.decision === "adopted") {
    const ctx = { prefecture: source.prefecture, sourceUrl: source.url, referenceDate };
    const added = newEvents(baseline.raws, candidate.raws, ctx);
    try {
      if (added.length > MAX_AUDIENCE_CHECK) {
        decision = {
          decision: "pending",
          reason: `${decision.reason}。新たに取れた項目が ${added.length} 件と多く、子供向けかを判定しきれないため、人間の確認に回す`,
        };
      } else {
        const offTarget = await countOffTarget(added, claude);
        decision = decideAdoption(baseline.report, candidate.report, { lost, offTarget });
      }
    } catch (e) {
      decision = {
        decision: "pending",
        reason: `${decision.reason}。子供向けかを判定できなかったため、人間の確認に回す（${e instanceof Error ? e.message : String(e)}）`,
      };
    }
  }
  const candidateStatus = decision.decision === "pending" ? "candidate" : "rejected";
  const statements =
    decision.decision === "adopted"
    ? [
        db.prepare("UPDATE extraction_configs SET status = 'retired', quality_score = ? WHERE id = ?").bind(baseline.report.score, active.id),
        db
          .prepare("UPDATE extraction_configs SET status = 'active', quality_score = ?, adopted_at = ? WHERE id = ?")
          .bind(candidate.report.score, now.toISOString(), candidateId),
      ]
    : [
        db.prepare("UPDATE extraction_configs SET quality_score = ? WHERE id = ?").bind(baseline.report.score, active.id),
        db.prepare("UPDATE extraction_configs SET status = ?, quality_score = ? WHERE id = ?").bind(candidateStatus, candidate.report.score, candidateId),
      ];
  statements.push(
    db
      .prepare(
        `INSERT INTO config_evaluations (source_id, baseline_config_id, candidate_config_id, baseline_score, candidate_score,
           baseline_metrics, candidate_metrics, sample_count, decision, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sourceId,
        active.id,
        candidateId,
        baseline.report.score,
        candidate.report.score,
        JSON.stringify(baseline.report),
        JSON.stringify(candidate.report),
        docs.length,
        decision.decision,
        decision.reason,
      ),
  );
  await db.batch(statements);

  return {
    sourceId,
    decision: decision.decision,
    reason: decision.reason,
    baseline: baseline.report,
    candidate: candidate.report,
    baselineConfigId: active.id,
    candidateConfigId: candidateId,
  };
}

/** クロール結果のうち、品質が閾値を下回った Claude 抽出の収集元について改善ジョブを回す */
export async function improveLowQuality(
  db: D1Database,
  results: (Pick<CrawlResult, "sourceId" | "type"> & { quality: { score: number } | null })[],
  deps: ImproveDeps,
): Promise<ImproveResult[]> {
  if (!deps.claude) return [];
  const out: ImproveResult[] = [];
  for (const r of results) {
    if (!r.type || !IMPROVABLE_TYPES.has(r.type) || !needsImprovement(r.quality?.score)) continue;
    out.push(await improveSource(db, r.sourceId, deps));
  }
  return out;
}

export type ImproveUntilOptions = { target: number; maxRounds: number; maxMisses: number };
export type ImproveUntilResult = {
  sourceId: number;
  stop: "reached" | "stalled" | "max-rounds" | "skipped" | "not-improvable";
  score: number | null;
  rounds: ImproveResult[];
};

export async function improveUntil(db: D1Database, sourceId: number, deps: ImproveDeps, opts: ImproveUntilOptions): Promise<ImproveUntilResult> {
  const rounds: ImproveResult[] = [];
  const done = (stop: ImproveUntilResult["stop"], score: number | null): ImproveUntilResult => ({ sourceId, stop, score, rounds });
  const source = await db.prepare("SELECT type FROM sources WHERE id = ?").bind(sourceId).first<{ type: string | null }>();
  if (!source?.type || !IMPROVABLE_TYPES.has(source.type)) return done("not-improvable", null);

  let score: number | null = null;
  let misses = 0;
  while (rounds.length < opts.maxRounds) {
    const r = await improveSource(db, sourceId, deps);
    rounds.push(r);
    if (r.decision === "skipped") return done("skipped", r.baseline?.score ?? score);
    score = r.decision === "adopted" ? r.candidate!.score : r.baseline!.score;
    if (score > opts.target) return done("reached", score);
    misses = r.decision === "adopted" ? 0 : misses + 1;
    if (misses >= opts.maxMisses) return done("stalled", score);
  }
  return done("max-rounds", score);
}
