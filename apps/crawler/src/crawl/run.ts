import { isDuplicate } from "@kids-event-hub/core";
import type { ClaudeClient } from "../claude";
import type { ExtractionConfig } from "../extract/config";
import { extractHtml } from "../extract/html";
import { extractIcal } from "../extract/ical";
import { extractJsonLd } from "../extract/jsonld";
import { extractPdf, findPdfLinks } from "../extract/pdf";
import { extractRss } from "../extract/rss";
import { summarizeEvents } from "../extract/summarize";
import type { RawEvent } from "../extract/types";
import { ensureActiveConfig, saveRawDocument } from "../improve/configs";
import { scoreExtraction, type QualityReport } from "../improve/quality";
import { detectType } from "./detect";
import { fetchDocument, FetchError, HostThrottle, isDue, USER_AGENT, type FetchedDocument } from "./fetch";
import { toEventRow, type EventRow } from "./normalize";
import { findNextPageLink } from "./pager";
import { checkRobots, parseRobots, type Robots } from "./robots";

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

export type Collected = {
  type: string | null;
  fetched: number;
  raws: RawEvent[];
  skipped: string[];
  warnings: string[];
  /** 一覧ページからたどって抽出できた PDF（URL と件数） */
  pdfs?: { url: string; extracted: number }[];
  /** 一覧ページからたどって取得・抽出に失敗した PDF。permanent は取得が 4xx（リンク切れなど）で、取り直しても直らない見込みのもの */
  pdfFailures?: PdfFailure[];
  /** 一覧ページに新しい PDF がなく、何も抽出しなかった */
  nothingNew?: boolean;
};

/** PDF の一覧ページで、1 回のクロールで取得・抽出する新しい PDF の上限 */
export const MAX_NEW_PDFS_PER_RUN = 5;
/** 取得が 4xx でこの回数失敗した PDF は取り直さない（Claude や相手サイトの一時的な障害は数えない） */
export const MAX_PDF_FAILURES = 3;
/** HTML の収集元で、「次のページ」をたどって読むページ数の上限（最初のページを含む） */
export const MAX_HTML_PAGES = 5;

type PdfFailure = { url: string; error: string; permanent: boolean };

export type CollectOptions = {
  /** HTML の LLM 抽出に使う収集元の抽出設定 */
  config?: ExtractionConfig;
  /** PDF 以外の文書を取得したとき呼ぶ（自動改善ループの検証用の生データ保存） */
  onDocument?: (doc: FetchedDocument) => Promise<void>;
  /** PDF の一覧ページで、抽出済み（またはあきらめた）ので読み直さない PDF の URL */
  knownPdfs?: ReadonlySet<string>;
  /** PDF の一覧ページで、前に失敗した PDF の URL。まだ試していない PDF の後に回す */
  retryPdfs?: ReadonlySet<string>;
  /** 1 回に取得・抽出する新しい PDF の上限 */
  maxNewPdfs?: number;
};

/** 収集元を取得して抽出し、要約を付ける（DB には書かない）。途中で失敗したら例外。それまでの経過は progress に残る */
export async function collect(
  source: { url: string; type?: unknown },
  deps: CrawlDeps,
  progress: Collected = { type: null, fetched: 0, raws: [], skipped: [], warnings: [] },
  options: CollectOptions = {},
): Promise<Collected> {
  const throttle = deps.throttle ?? new HostThrottle({ now: () => deps.now().getTime(), sleep: deps.sleep });
  const url = new URL(source.url);
  const robotsUrl = `${url.origin}/robots.txt`;
  const robotsRules = await fetchRobots(url, deps);
  const robots = checkRobots(robotsRules, url.pathname + url.search, USER_AGENT);
  if (!robots.allowed) throw new RobotsDisallowed(robotsUrl, robots.rule ?? "Disallow");

  await throttle.wait(url.host, robots.crawlDelaySec);
  const doc = await fetchDocument(source.url, { fetch: deps.fetch });
  progress.fetched = 1;

  const detected = detectType({ contentType: doc.contentType, url: doc.url, body: doc.text });
  progress.type = detected;
  const declared = String(source.type ?? "");
  let raws: RawEvent[];
  if (detected === "pdf") {
    raws = await extractPdf(doc.bytes, doc.url, requireClaude(deps.claude, "PDF"));
  } else if (declared === "pdf" && detected === "html") {
    progress.type = "pdf";
    const links = findPdfLinks(doc.text, doc.url).filter((l) => new URL(l).host === url.host);
    if (links.length === 0) throw new CrawlError(`一覧ページ（${doc.url}）に PDF へのリンクが見つかりません`);
    const allowed: { link: string; check: ReturnType<typeof checkRobots> }[] = [];
    for (const link of links) {
      const lu = new URL(link);
      const check = checkRobots(robotsRules, lu.pathname + lu.search, USER_AGENT);
      if (check.allowed) allowed.push({ link, check });
      else progress.skipped.push(`${link} は robots.txt（${robotsUrl}）の ${check.rule} で禁止のため取得しません`);
    }
    if (allowed.length === 0) throw new CrawlError(progress.skipped.join(" / "));
    const fresh = allowed.filter((a) => !options.knownPdfs?.has(a.link));
    if (fresh.length === 0) {
      progress.nothingNew = true;
      progress.raws = [];
      return progress;
    }
    const retry = (a: { link: string }) => (options.retryPdfs?.has(a.link) ? 1 : 0);
    const ordered = [...fresh].sort((a, b) => retry(a) - retry(b));
    const batch = ordered.slice(0, options.maxNewPdfs ?? MAX_NEW_PDFS_PER_RUN);
    if (ordered.length > batch.length) progress.warnings.push(`新しい PDF のうち ${ordered.length - batch.length} 件は次回のクロールで取得します`);
    const claude = requireClaude(deps.claude, "PDF");
    raws = [];
    progress.pdfs = [];
    progress.pdfFailures = [];
    for (const { link, check } of batch) {
      try {
        await throttle.wait(new URL(link).host, check.crawlDelaySec);
        const pdfDoc = await fetchDocument(link, { fetch: deps.fetch });
        progress.fetched++;
        const found = await extractPdf(pdfDoc.bytes, pdfDoc.url, claude);
        raws.push(...found);
        progress.pdfs.push({ url: link, extracted: found.length });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const permanent = e instanceof FetchError && e.status !== null && e.status >= 400 && e.status < 500;
        progress.pdfFailures.push({ url: link, error, permanent });
        progress.skipped.push(`${link} の取得・抽出に失敗（${error}）`);
      }
    }
    if (progress.pdfs.length === 0) throw new CrawlError(progress.skipped.join(" / "));
  } else {
    await options.onDocument?.(doc);
    const extracted = await extractDocument(doc.text, doc.url, detected, declared, deps.claude, options.config, deps.now());
    progress.type = extracted.type;
    raws = extracted.raws;
    if (declared === "html") raws.push(...(await followNextPages(doc, url, robotsRules, robotsUrl, throttle, deps, progress, options)));
  }
  progress.raws = raws;

  if (deps.claude) {
    try {
      progress.raws = await summarizeEvents(raws, deps.claude);
    } catch (e) {
      progress.warnings.push(`要約を作れなかったため要約なしで保存しました（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return progress;
}

async function followNextPages(
  first: FetchedDocument,
  sourceUrl: URL,
  robotsRules: Robots | null,
  robotsUrl: string,
  throttle: HostThrottle,
  deps: CrawlDeps,
  progress: Collected,
  options: CollectOptions,
): Promise<RawEvent[]> {
  const raws: RawEvent[] = [];
  const visited = new Set([sourceUrl.href, first.url]);
  let current = first;
  for (let pages = 1; ; pages++) {
    const next = findNextPageLink(current.text, current.url);
    if (!next || visited.has(next) || new URL(next).host !== sourceUrl.host) return raws;
    if (pages >= MAX_HTML_PAGES) {
      progress.warnings.push(`次のページ（${next}）以降は、${MAX_HTML_PAGES} ページの上限を超えるため読みません`);
      return raws;
    }
    visited.add(next);
    const nu = new URL(next);
    const check = checkRobots(robotsRules, nu.pathname + nu.search, USER_AGENT);
    if (!check.allowed) {
      progress.skipped.push(`${next} は robots.txt（${robotsUrl}）の ${check.rule} で禁止のため取得しません`);
      return raws;
    }
    try {
      await throttle.wait(nu.host, check.crawlDelaySec);
      const doc = await fetchDocument(next, { fetch: deps.fetch });
      progress.fetched++;
      const detected = detectType({ contentType: doc.contentType, url: doc.url, body: doc.text });
      if (detected !== "html") throw new CrawlError(`HTML ではありません（${detected}）`);
      await options.onDocument?.(doc);
      const extracted = await extractDocument(doc.text, doc.url, detected, "html", deps.claude, options.config, deps.now());
      raws.push(...extracted.raws);
      current = doc;
    } catch (e) {
      progress.skipped.push(`次のページ（${next}）の取得・抽出に失敗（${e instanceof Error ? e.message : String(e)}）`);
      return raws;
    }
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
  const progress: Collected = { type: null, fetched: 0, raws: [], skipped: [], warnings: [] };

  try {
    const config = await ensureActiveConfig(db, source.id, startedAt);
    const tried = await db
      .prepare("SELECT url, status, fail_count FROM pdf_documents WHERE source_id = ?")
      .bind(source.id)
      .all<{ url: string; status: string; fail_count: number }>();
    const done = tried.results.filter((r) => r.status === "extracted" || r.fail_count >= MAX_PDF_FAILURES);
    await db.prepare("UPDATE crawl_runs SET config_id = ? WHERE id = ?").bind(config.id, runId).run();
    await collect(source, deps, progress, {
      config: config.config,
      knownPdfs: new Set(done.map((r) => r.url)),
      retryPdfs: new Set(tried.results.filter((r) => !done.includes(r)).map((r) => r.url)),
      onDocument: async (doc) => {
        await saveRawDocument(db, { sourceId: source.id, runId, url: doc.url, contentType: doc.contentType, body: doc.text, fetchedAt: startedAt });
      },
    });
    result.extracted = progress.raws.length;
    result.quality = progress.nothingNew
      ? null
      : scoreExtraction(progress.raws, { prefecture: source.prefecture, sourceUrl: source.url, referenceDate: startedAt });
    const rows = progress.raws
      .map((r) => toEventRow(r, { prefecture: source.prefecture, sourceUrl: source.url, referenceDate: startedAt }))
      .filter((r): r is EventRow => r !== null);
    result.dateFound = rows.length;

    const saved = await save(db, source.id, runId, rows);
    result.upserted = saved.upserted;
    result.duplicates = saved.duplicates;
    result.status = result.dateFound < result.extracted || progress.skipped.length > 0 ? "partial" : "success";
    const notes = [...progress.skipped, ...progress.warnings];
    result.error = notes.length > 0 ? notes.join(" / ") : null;
  } catch (e) {
    result.status = "failed";
    result.error = e instanceof Error ? e.message : String(e);
    if (e instanceof RobotsDisallowed) await rejectSource(db, source, e, startedAt);
  }
  try {
    await recordPdfs(db, source.id, runId, result.status === "failed" ? [] : (progress.pdfs ?? []), progress.pdfFailures ?? [], startedAt);
  } catch (e) {
    const note = `PDF の取得結果を記録できませんでした（${e instanceof Error ? e.message : String(e)}）`;
    result.error = result.error ? `${result.error} / ${note}` : note;
  }
  result.type = progress.type;
  const fetched = progress.fetched;

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

/** 一覧ページからたどった PDF の結果を記録する。抽出済みは次回から読まない。失敗は回数を数える */
async function recordPdfs(
  db: D1Database,
  sourceId: number,
  runId: number,
  extracted: { url: string; extracted: number }[],
  failed: PdfFailure[],
  at: Date,
) {
  const statements = [
    ...extracted.map((p) =>
      db
        .prepare(
          `INSERT INTO pdf_documents (source_id, crawl_run_id, url, status, extracted_count, last_error, last_tried_at)
           VALUES (?, ?, ?, 'extracted', ?, NULL, ?)
           ON CONFLICT (source_id, url) DO UPDATE SET crawl_run_id = excluded.crawl_run_id, status = 'extracted',
             extracted_count = excluded.extracted_count, last_error = NULL, last_tried_at = excluded.last_tried_at`,
        )
        .bind(sourceId, runId, p.url, p.extracted, at.toISOString()),
    ),
    ...failed.map((p) =>
      db
        .prepare(
          `INSERT INTO pdf_documents (source_id, crawl_run_id, url, status, fail_count, last_error, last_tried_at)
           VALUES (?, ?, ?, 'failed', ?, ?, ?)
           ON CONFLICT (source_id, url) DO UPDATE SET crawl_run_id = excluded.crawl_run_id, status = 'failed',
             fail_count = pdf_documents.fail_count + excluded.fail_count, last_error = excluded.last_error, last_tried_at = excluded.last_tried_at`,
        )
        .bind(sourceId, runId, p.url, p.permanent ? 1 : 0, p.error, at.toISOString()),
    ),
  ];
  if (statements.length > 0) await db.batch(statements);
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

/** robots.txt を取得して読む。404 などは「制限なし」（null）、5xx・取得失敗は今回は見送り */
async function fetchRobots(url: URL, deps: CrawlDeps): Promise<Robots | null> {
  try {
    const doc = await fetchDocument(`${url.origin}/robots.txt`, { fetch: deps.fetch, maxBytes: 512 * 1024 });
    return parseRobots(doc.text);
  } catch (e) {
    if (e instanceof FetchError && e.status !== null && e.status >= 400 && e.status < 500) return null;
    throw new CrawlError(`robots.txt を確認できないため取得を見送りました（${(e as Error).message}）`);
  }
}

function requireClaude(claude: ClaudeClient | null, what: string): ClaudeClient {
  if (!claude) throw new CrawlError(`${what} の抽出には Claude API が必要です（ANTHROPIC_API_KEY 未設定）`);
  return claude;
}

/** 取得した文書から抽出する。HTML の LLM 抽出には収集元の抽出設定（config）と取得日（referenceDate）を使う */
export async function extractDocument(
  text: string,
  url: string,
  detected: ReturnType<typeof detectType>,
  declared: string,
  claude: ClaudeClient | null,
  config: ExtractionConfig = {},
  referenceDate: Date = new Date(),
): Promise<{ type: string; raws: RawEvent[] }> {
  switch (detected) {
    case "pdf":
      throw new CrawlError("PDF は保存した生データからの再抽出に対応していません");
    case "ical":
      return { type: "ical", raws: extractIcal(text) };
    case "rss":
      return { type: "rss", raws: extractRss(text) };
    case "jsonld": {
      const raws = extractJsonLd(text, url);
      if (raws.length > 0) return { type: "jsonld", raws };
      return { type: "llm", raws: await llm(text, url, claude, config, referenceDate) };
    }
    case "html":
      // JSON-LD / iCal / RSS のつもりで登録したのに普通の HTML だった → LLM フォールバック
      return { type: declared === "html" ? "html" : "llm", raws: await llm(text, url, claude, config, referenceDate) };
  }
}

async function llm(html: string, url: string, claude: ClaudeClient | null, config: ExtractionConfig, referenceDate: Date): Promise<RawEvent[]> {
  return extractHtml(html, url, requireClaude(claude, "HTML"), config, referenceDate);
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
    apply_text: r.applyText ?? null,
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
