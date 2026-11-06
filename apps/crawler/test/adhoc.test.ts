import { describe, it, expect } from "vitest";
import prodConfig from "../wrangler.prod.jsonc?raw";
import cronConfig from "../wrangler.jsonc?raw";
import { parseCrawlProdArgs } from "../src/crawl/adhoc";

describe("parseCrawlProdArgs", () => {
  it("引数なしなら本番 D1 の全収集元を間隔の制限なしで取る", () => {
    expect(parseCrawlProdArgs([])).toEqual({ local: false, options: { force: true } });
  });

  it("--source は複数指定できる（間隔の制限はかけない）", () => {
    expect(parseCrawlProdArgs(["--source", "3", "--source", "12"])).toEqual({
      local: false,
      options: { sourceIds: [3, 12], force: true },
    });
  });

  it("--local なら本番ではなくローカル D1 に向ける（動作確認用）", () => {
    expect(parseCrawlProdArgs(["--local", "--source", "3"])).toEqual({ local: true, options: { sourceIds: [3], force: true } });
  });

  it("--force はなくなったので知らない引数としてエラー", () => {
    expect(() => parseCrawlProdArgs(["--force"])).toThrow("--force");
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
    expect(prod.triggers).toBeUndefined();
  });
});
