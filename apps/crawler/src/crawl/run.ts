import { isDuplicate } from "@kids-event-hub/core";
import type { ClaudeClient } from "../claude";
import type { ExtractionConfig } from "../extract/config";
import { extractHtml } from "../extract/html";
import { extractIcal } from "../extract/ical";
import { extractJsonLd } from "../extract/jsonld";
import { extractRss } from "../extract/rss";
import { summarizeEvents } from "../extract/summarize";
import { ensureActiveConfig, saveRawDocument } from "../improve/configs";
import { scoreExtraction, type QualityReport } from "../improve/quality";
import type { RawEvent } from "../extract/types";
import { detectType } from "./detect";
import { fetchDocument, FetchError, HostThrottle, isDue, USER_AGENT } from "./fetch";
import { toEventRow, type EventRow } from "./normalize";
import { checkRobots, parseRobots, type RobotsCheck } from "./robots";

export type CrawlDeps = {
  fetch: typeof fetch;
  /** null なら HTML の LLM 抽出はできない（failed として記録） */
  claude: ClaudeClient | null;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  throttle?: HostThrottle;
};

/** クロール対象の sources の行（D1 の列名のまま） */
export type SourceRow = Record<string, unknown> & { id: number; url: string; prefecture: string };

export type CrawlResult = {
  sourceId: number;
  runId: number;
  status: "success" | "partial" | "failed";
  /** 実際に使った抽出手段（JSON-LD が見つからず LLM に落ちたら llm） */
  type: string | null;
  extracted: number;
  dateFound: number;
  upserted: number;
  duplicates: number;
  /** 抽出品質。取得・抽出に失敗して採点できなかったら null */
  quality: QualityReport | null;
  error: string | null;
};

class CrawlError extends Error {}

class RobotsDisallowed extends CrawlError {
  constructor(
    readonly robotsUrl: string,
    readonly rule: string,
  ) {
    super(`robots.txt（${robotsUrl}）の ${rule} で禁止されているため取得しません`);
  }
}

/** 1 つの収集元をクロールし、events に保存して crawl_runs に記録する。失敗しても例外にせず failed を返す */
export async function crawlSource(db: D1Database, source: SourceRow, deps: CrawlDeps): Promise<CrawlResult> {
  const startedAt = deps.now();
  const run = await db
    .prepare("INSERT INTO crawl_runs (source_id, status, started_at) VALUES (?, 'running', ?) RETURNING id")
    .bind(source.id, startedAt.toISOString())
    .first<{ id: number }>();
  const runId = run!.id;
  const result: CrawlResult = {
    sourceId: source.id,
    runId,
    status: "failed",
    type: null,
    extracted: 0,
    dateFound: 0,
    upserted: 0,
    duplicates: 0,
    quality: null,
    error: null,
  };
  let fetched = 0;
  const throttle = deps.throttle ?? new HostThrottle({ now: () => deps.now().getTime(), sleep: deps.sleep });

  try {
    const url = new URL(source.url);
    const robotsUrl = `${url.origin}/robots.txt`;
    const robots = await fetchRobots(url, deps);
    if (!robots.allowed) throw new RobotsDisallowed(robotsUrl, robots.rule ?? "Disallow");

    await throttle.wait(url.host, robots.crawlDelaySec);
    const doc = await fetchDocument(source.url, { fetch: deps.fetch });
    fetched = 1;
    // 自動改善ループの検証用に生データを残す（公開しない）
    await saveRawDocument(db, { sourceId: source.id, runId, url: doc.url, contentType: doc.contentType, body: doc.text, fetchedAt: startedAt });

    const config = await ensureActiveConfig(db, source.id, startedAt);
    await db.prepare("UPDATE crawl_runs SET config_id = ? WHERE id = ?").bind(config.id, runId).run();

    const detected = detectType({ contentType: doc.contentType, url: doc.url, body: doc.text });
    result.type = detected;
    const extracted = await extractDocument(doc.text, doc.url, detected, String(source.type ?? ""), deps.claude, config.config);
    result.type = extracted.type;
    result.extracted = extracted.raws.length;
    result.quality = scoreExtraction(extracted.raws, { prefecture: source.prefecture, sourceUrl: source.url, referenceDate: startedAt });
    let raws = extracted.raws;
    if (deps.claude) {
      try {
        raws = await summarizeEvents(raws, deps.claude);
      } catch (e) {
        result.error = `要約を作れなかったため要約なしで保存しました（${e instanceof Error ? e.message : String(e)}）`;
      }
    }

    const rows = raws
      .map((r) => toEventRow(r, { prefecture: source.prefecture, sourceUrl: source.url, referenceDate: startedAt }))
      .filter((r): r is EventRow => r !== null);
    result.dateFound = rows.length;

    const saved = await save(db, source.id, runId, rows);
    result.upserted = saved.upserted;
    result.duplicates = saved.duplicates;
    result.status = result.dateFound < result.extracted ? "partial" : "success";
  } catch (e) {
    result.status = "failed";
    result.error = e instanceof Error ? e.message : String(e);
    if (e instanceof RobotsDisallowed) await rejectSource(db, source, e, startedAt);
  }

  const finishedAt = deps.now();
  await db
    .prepare(
      `UPDATE crawl_runs SET status = ?, finished_at = ?, duration_ms = ?, fetched_count = ?, extracted_count = ?,
         date_found_count = ?, upserted_count = ?, quality_score = ?, error_message = ? WHERE id = ?`,
    )
    .bind(
      result.status,
      finishedAt.toISOString(),
      finishedAt.getTime() - startedAt.getTime(),
      fetched,
      result.extracted,
      result.dateFound,
      result.upserted,
      result.quality?.score ?? null,
      result.error,
      runId,
    )
    .run();
  return result;
}

async function rejectSource(db: D1Database, source: SourceRow, e: RobotsDisallowed, at: Date) {
  const note = `robots.txt で禁止: ${e.robotsUrl} の ${e.rule} が対象 URL ${source.url} に該当（${at.toISOString()} のクロールで検出）`;
  await db
    .prepare(
      `UPDATE sources SET status = 'rejected', policy_status = 'ng', policy_checked_at = ?, policy_note = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .bind(at.toISOString(), note, source.id)
    .run();
}

/** robots.txt を取得して判定する。404 などは「制限なし」、5xx・取得失敗は今回は見送り */
async function fetchRobots(url: URL, deps: CrawlDeps): Promise<RobotsCheck> {
  try {
    const doc = await fetchDocument(`${url.origin}/robots.txt`, { fetch: deps.fetch, maxBytes: 512 * 1024 });
    return checkRobots(parseRobots(doc.text), url.pathname + url.search, USER_AGENT);
  } catch (e) {
    if (e instanceof FetchError && e.status !== null && e.status >= 400 && e.status < 500) {
      return checkRobots(null, url.pathname, USER_AGENT);
    }
    throw new CrawlError(`robots.txt を確認できないため取得を見送りました（${(e as Error).message}）`);
  }
}

/** 取得した文書から抽出する。HTML の LLM 抽出には収集元の抽出設定（config）を使う */
export async function extractDocument(
  text: string,
  url: string,
  detected: ReturnType<typeof detectType>,
  declared: string,
  claude: ClaudeClient | null,
  config: ExtractionConfig = {},
): Promise<{ type: string; raws: RawEvent[] }> {
  switch (detected) {
    case "ical":
      return { type: "ical", raws: extractIcal(text) };
    case "rss":
      return { type: "rss", raws: extractRss(text) };
    case "pdf":
      throw new CrawlError("PDF の抽出は未実装です（#8 で対応）");
    case "jsonld": {
      const raws = extractJsonLd(text, url);
      if (raws.length > 0) return { type: "jsonld", raws };
      return { type: "llm", raws: await llm(text, url, claude, config) };
    }
    case "html":
      // JSON-LD / iCal / RSS のつもりで登録したのに普通の HTML だった → LLM フォールバック
      return { type: declared === "html" ? "html" : "llm", raws: await llm(text, url, claude, config) };
  }
}

async function llm(html: string, url: string, claude: ClaudeClient | null, config: ExtractionConfig): Promise<RawEvent[]> {
  if (!claude) throw new CrawlError("HTML の抽出には Claude API が必要です（ANTHROPIC_API_KEY 未設定）");
  return extractHtml(html, url, claude, config);
}

type Existing = { source_id: number; dedup_key: string; title: string; start_at: string; venue: string | null };

/**
 * 同じ収集元の中で重複を除き、同じ都道府県・同じ日の既存イベントと重複していなければ upsert する。
 * 同じ収集元で重複キーが同じなら同じイベントとして更新する
 */
async function save(db: D1Database, sourceId: number, runId: number, rows: EventRow[]) {
  const kept: EventRow[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const candidate = { title: row.title, start: row.startAt, venue: row.venue };
    if (kept.some((k) => k.dedupKey === row.dedupKey || isDuplicate({ title: k.title, start: k.startAt, venue: k.venue }, candidate))) {
      duplicates++;
      continue;
    }
    const day = row.startAt.slice(0, 10);
    const { results } = await db
      .prepare("SELECT source_id, dedup_key, title, start_at, venue FROM events WHERE prefecture = ? AND substr(start_at, 1, 10) = ?")
      .bind(row.prefecture, day)
      .all<Existing>();
    // 同じ収集元の同じ重複キーは更新。別の収集元のものは先に入った方を残す
    const dup = results.some((e) =>
      e.dedup_key === row.dedupKey
        ? e.source_id !== sourceId
        : isDuplicate({ title: e.title, start: e.start_at, venue: e.venue }, candidate),
    );
    if (dup) {
      duplicates++;
      continue;
    }
    kept.push(row);
  }
  if (kept.length > 0) await db.batch(kept.map((r) => upsert(db, sourceId, runId, r)));
  return { upserted: kept.length, duplicates };
}

function upsert(db: D1Database, sourceId: number, runId: number, r: EventRow): D1PreparedStatement {
  const cols: Record<string, unknown> = {
    source_id: sourceId,
    crawl_run_id: runId,
    title: r.title,
    summary: r.summary ?? null,
    start_at: r.startAt,
    end_at: r.endAt ?? null,
    all_day: r.allDay ? 1 : 0,
    recurrence: r.recurrence ? JSON.stringify(r.recurrence) : null,
    prefecture: r.prefecture,
    city: r.city ?? null,
    venue: r.venue ?? null,
    age_min: r.ageMin ?? null,
    age_max: r.ageMax ?? null,
    with_parent: r.withParent === null || r.withParent === undefined ? null : r.withParent ? 1 : 0,
    age_text: r.ageText ?? null,
    price_free: r.priceFree === null || r.priceFree === undefined ? null : r.priceFree ? 1 : 0,
    price_min_yen: r.priceMinYen ?? null,
    price_max_yen: r.priceMaxYen ?? null,
    price_text: r.priceText ?? null,
    categories: JSON.stringify(r.categories ?? []),
    source_url: r.sourceUrl,
    dedup_key: r.dedupKey,
  };
  const keys = Object.keys(cols);
  const updates = keys.filter((k) => k !== "dedup_key").map((k) => `${k} = excluded.${k}`);
  return db
    .prepare(
      `INSERT INTO events (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})
       ON CONFLICT (dedup_key) DO UPDATE SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(...Object.values(cols));
}

/**
 * クロール対象（approved・有効・policy が ng でない）のうち、前回から MIN_INTERVAL_HOURS 以上たった収集元を順にクロールする。
 * 条件は packages/db の crawlTargets と同じ
 */
export async function crawlAll(db: D1Database, deps: CrawlDeps): Promise<CrawlResult[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*, (SELECT max(started_at) FROM crawl_runs r WHERE r.source_id = s.id) AS last_started_at
       FROM sources s
       WHERE s.status = 'approved' AND s.enabled = 1 AND coalesce(s.policy_status, '') <> 'ng'
       ORDER BY s.id`,
    )
    .all<SourceRow & { last_started_at: string | null }>();
  const throttle = deps.throttle ?? new HostThrottle({ now: () => deps.now().getTime(), sleep: deps.sleep });
  const out: CrawlResult[] = [];
  for (const s of results) {
    if (!isDue(s.last_started_at, deps.now())) continue;
    out.push(await crawlSource(db, s, { ...deps, throttle }));
  }
  return out;
}
