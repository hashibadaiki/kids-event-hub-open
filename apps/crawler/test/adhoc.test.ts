import { describe, it, expect } from "vitest";
import prodConfig from "../wrangler.prod.jsonc?raw";
import cronConfig from "../wrangler.jsonc?raw";
import { parseCrawlProdArgs, parseImproveProdArgs } from "../src/crawl/adhoc";

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

  it("--url で収集元を URL で指定できる（ID は本番 D1 で引く）", () => {
    expect(parseCrawlProdArgs(["--url", "https://example.jp/events/"])).toEqual({
      local: false,
      options: { force: true },
      urls: ["https://example.jp/events/"],
    });
    expect(() => parseCrawlProdArgs(["--url", "example.jp"])).toThrow("--url");
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

describe("parseImproveProdArgs", () => {
  it("--source は必須。既定は目標 0.95・上限 5 回・不採用 2 回連続で止める・本番 D1", () => {
    expect(parseImproveProdArgs(["--source", "59"])).toEqual({ local: false, sourceId: 59, target: 0.95, maxRounds: 5, maxMisses: 2 });
  });

  it("目標・上限・ローカルを指定できる", () => {
    expect(parseImproveProdArgs(["--source", "3", "--target", "0.9", "--max-rounds", "8", "--max-misses", "3", "--local"])).toEqual({
      local: true,
      sourceId: 3,
      target: 0.9,
      maxRounds: 8,
      maxMisses: 3,
    });
  });

  it("--source の代わりに --url で指定できる", () => {
    expect(parseImproveProdArgs(["--url", "https://example.jp/events/"])).toEqual({
      local: false,
      url: "https://example.jp/events/",
      target: 0.95,
      maxRounds: 5,
      maxMisses: 2,
    });
    expect(() => parseImproveProdArgs(["--url", "ftp://x"])).toThrow("--url");
  });

  it("--source も --url もない・数字でなければエラー", () => {
    expect(() => parseImproveProdArgs([])).toThrow("--source");
    expect(() => parseImproveProdArgs(["--source", "x"])).toThrow("--source");
  });

  it("目標は 0〜1、回数は 1 以上の整数", () => {
    expect(() => parseImproveProdArgs(["--source", "1", "--target", "1.5"])).toThrow("--target");
    expect(() => parseImproveProdArgs(["--source", "1", "--max-rounds", "0"])).toThrow("--max-rounds");
    expect(() => parseImproveProdArgs(["--source", "1", "--max-misses", "a"])).toThrow("--max-misses");
  });

  it("知らない引数はエラー", () => {
    expect(() => parseImproveProdArgs(["--source", "1", "--all"])).toThrow("--all");
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
