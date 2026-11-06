import { describe, it, expect } from "vitest";
import prodConfig from "../wrangler.prod.jsonc?raw";
import cronConfig from "../wrangler.jsonc?raw";
import { adhocOptionsFromEnv, parseCrawlProdArgs } from "../src/crawl/adhoc";

describe("adhocOptionsFromEnv", () => {
  it("変数がなければ Cron と同じ（絞り込みなし）", () => {
    expect(adhocOptionsFromEnv({})).toEqual({});
  });

  it("CRAWL_SOURCE_IDS と CRAWL_FORCE を読む", () => {
    expect(adhocOptionsFromEnv({ CRAWL_SOURCE_IDS: "3,12", CRAWL_FORCE: "1" })).toEqual({ sourceIds: [3, 12], force: true });
  });

  it("id が数字でなければエラー", () => {
    expect(() => adhocOptionsFromEnv({ CRAWL_SOURCE_IDS: "3,x" })).toThrow("CRAWL_SOURCE_IDS");
  });
});

describe("parseCrawlProdArgs", () => {
  it("引数なしなら変数を渡さない", () => {
    expect(parseCrawlProdArgs([])).toEqual({ vars: [] });
  });

  it("--source は複数指定でき、--force と一緒に wrangler dev の --var にする", () => {
    expect(parseCrawlProdArgs(["--source", "3", "--source", "12", "--force"])).toEqual({
      vars: ["CRAWL_SOURCE_IDS:3,12", "CRAWL_FORCE:1"],
    });
  });

  it("--force は --source なしでは使えない", () => {
    expect(() => parseCrawlProdArgs(["--force"])).toThrow("--source");
  });

  it("--source の値が数字でなければエラー", () => {
    expect(() => parseCrawlProdArgs(["--source", "abc"])).toThrow("--source");
    expect(() => parseCrawlProdArgs(["--source"])).toThrow("--source");
  });

  it("知らない引数はエラー", () => {
    expect(() => parseCrawlProdArgs(["--all"])).toThrow("--all");
  });
});

describe("wrangler.prod.jsonc", () => {
  const parse = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

  it("Cron 用の設定と同じ本番 D1 を remote binding で使い、Cron Trigger は持たない", () => {
    const prod = parse(prodConfig);
    const cron = parse(cronConfig);
    expect(prod.d1_databases).toEqual([{ ...cron.d1_databases[0], remote: true }]);
    expect(prod.main).toBe(cron.main);
    expect(prod.triggers).toBeUndefined();
  });
});
