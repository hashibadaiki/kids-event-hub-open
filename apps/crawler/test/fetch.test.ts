import { describe, it, expect, vi } from "vitest";
import { fetchDocument, FetchError, USER_AGENT, HostThrottle, isDue } from "../src/crawl/fetch";

describe("fetchDocument", () => {
  it("連絡先付きの User-Agent で取得する", async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      new Response("<html>ok</html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const doc = await fetchDocument("https://a.jp/x", { fetch: fetchMock });
    expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get("user-agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/\+https:\/\/github\.com\/hashibadaiki\/kids-event-hub-open/);
    expect(doc.contentType).toBe("text/html; charset=utf-8");
    expect(doc.text).toBe("<html>ok</html>");
    expect(doc.bytes.byteLength).toBe(15);
  });

  it("サイズ上限を超えたら打ち切って例外", async () => {
    const big = "a".repeat(2000);
    await expect(fetchDocument("https://a.jp/x", { fetch: async () => new Response(big), maxBytes: 1000 })).rejects.toThrow(
      FetchError,
    );
    const withLength = new Response("x", { headers: { "content-length": "99999" } });
    await expect(fetchDocument("https://a.jp/x", { fetch: async () => withLength, maxBytes: 1000 })).rejects.toThrow(/上限/);
  });

  it("タイムアウトしたら例外", async () => {
    const hang = (_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(fetchDocument("https://a.jp/x", { fetch: hang, timeoutMs: 10 })).rejects.toThrow(/タイムアウト/);
  });

  it("2xx 以外は例外（status を持つ）", async () => {
    const p = fetchDocument("https://a.jp/x", { fetch: async () => new Response("no", { status: 404 }) });
    await expect(p).rejects.toMatchObject({ status: 404 });
  });

  it("Shift_JIS の HTML を charset に従ってデコードする", async () => {
    // 「子供」の Shift_JIS
    const sjis = new Uint8Array([0x8e, 0x71, 0x8b, 0x9f]);
    const doc = await fetchDocument("https://a.jp/x", {
      fetch: async () => new Response(sjis, { headers: { "content-type": "text/html; charset=Shift_JIS" } }),
    });
    expect(doc.text).toBe("子供");
  });
});

describe("HostThrottle", () => {
  it("同じホストへは Crawl-delay（既定 1 秒）以上あけて取得する", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const throttle = new HostThrottle({ now: () => now, sleep });
    await throttle.wait("a.jp", null);
    expect(sleep).not.toHaveBeenCalled();
    now += 300;
    await throttle.wait("a.jp", null);
    expect(sleep).toHaveBeenLastCalledWith(700);
    await throttle.wait("a.jp", 5);
    expect(sleep).toHaveBeenLastCalledWith(5000);
    await throttle.wait("b.jp", 5);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("Crawl-delay は上限 60 秒で丸める", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const throttle = new HostThrottle({ now: () => now, sleep });
    await throttle.wait("a.jp", 3600);
    await throttle.wait("a.jp", 3600);
    expect(sleep).toHaveBeenLastCalledWith(60_000);
  });
});

describe("isDue（取得頻度の上限: 1 日 1 回程度）", () => {
  const now = new Date("2026-11-03T18:00:00Z");
  it("前回から 20 時間たっていなければ取得しない", () => {
    expect(isDue(null, now)).toBe(true);
    expect(isDue("2026-11-02T18:00:00.000Z", now)).toBe(true);
    expect(isDue("2026-11-03T00:00:00.000Z", now)).toBe(false);
  });
});
