/** 連絡先（リポジトリの URL）付きの User-Agent。削除依頼などの窓口は README に書いてある */
export const USER_AGENT = "kids-event-hub-crawler/0.1 (+https://github.com/hashibadaiki/kids-event-hub-open)";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Crawl-delay の指定がないときに同じホストへあける間隔 */
export const DEFAULT_DELAY_SEC = 1;
/** Crawl-delay が大きすぎるときの上限（1 回の Cron 実行の中で待ち切れる長さ） */
export const MAX_DELAY_SEC = 60;
/** 取得頻度の上限。1 日 1 回程度にしたいので、前回から 20 時間あける */
export const MIN_INTERVAL_HOURS = 20;

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export type FetchedDocument = {
  url: string;
  contentType: string | null;
  bytes: Uint8Array;
  text: string;
};

export type FetchOptions = { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number };

/** サイズ上限・タイムアウト付きで取得する。2xx 以外は FetchError */
export async function fetchDocument(url: string, opts: FetchOptions = {}): Promise<FetchedDocument> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await doFetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new FetchError(`HTTP ${res.status}: ${url}`, res.status);
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) throw tooLarge(url, maxBytes);
    const bytes = await readLimited(res, maxBytes, url);
    const contentType = res.headers.get("content-type");
    return { url: res.url || url, contentType, bytes, text: decode(bytes, contentType) };
  } catch (e) {
    if (timedOut) throw new FetchError(`タイムアウト（${timeoutMs}ms）: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const tooLarge = (url: string, maxBytes: number) => new FetchError(`サイズ上限（${maxBytes} bytes）を超えました: ${url}`);

async function readLimited(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(url, maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Content-Type の charset → HTML / XML 内の宣言 → UTF-8 の順で文字コードを決める */
function decode(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const charset =
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** 同じホストへの取得間隔を守る（Crawl-delay、なければ DEFAULT_DELAY_SEC） */
export class HostThrottle {
  private last = new Map<string, number>();
  constructor(private readonly deps: { now: () => number; sleep: (ms: number) => Promise<void> }) {}

  async wait(host: string, crawlDelaySec: number | null): Promise<void> {
    const delayMs = Math.min(crawlDelaySec ?? DEFAULT_DELAY_SEC, MAX_DELAY_SEC) * 1000;
    const prev = this.last.get(host);
    if (prev !== undefined) {
      const waitMs = prev + delayMs - this.deps.now();
      if (waitMs > 0) await this.deps.sleep(waitMs);
    }
    this.last.set(host, this.deps.now());
  }
}

/** 前回の取得開始（ISO 8601）から MIN_INTERVAL_HOURS 以上たっているか */
export function isDue(lastStartedAt: string | null, now: Date): boolean {
  if (!lastStartedAt) return true;
  const last = new Date(lastStartedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= MIN_INTERVAL_HOURS * 60 * 60 * 1000;
}
