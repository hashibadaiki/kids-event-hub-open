import { describe, it, expect } from "vitest";
import { inferSourceType, parseSourcesFile } from "../src/sources/file";

const yaml = (s: string) => s.trim() + "\n";

describe("parseSourcesFile", () => {
  it("必須項目（name / url / prefecture）と任意項目を読める", () => {
    const { entries, errors } = parseSourcesFile(
      yaml(`
sources:
  - name: 高松市こども未来館
    url: https://example.jp/miraikan/events.pdf
    prefecture: 香川県
    type: pdf
    note: 毎月 PDF が更新される
    policy:
      status: ok
      checked_at: "2026-11-03"
      note: robots.txt に禁止なし
  - name: 丸亀市立図書館
    url: https://example.jp/marugame/library
    prefecture: 香川県
    enabled: false
`),
    );
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      {
        name: "高松市こども未来館",
        url: "https://example.jp/miraikan/events.pdf",
        prefecture: "香川県",
        type: "pdf",
        enabled: true,
        note: "毎月 PDF が更新される",
        policy: { status: "ok", checkedAt: "2026-11-03", note: "robots.txt に禁止なし" },
      },
      {
        name: "丸亀市立図書館",
        url: "https://example.jp/marugame/library",
        prefecture: "香川県",
        type: "html",
        enabled: false,
        note: null,
        policy: null,
      },
    ]);
  });

  it("空のファイル・空の一覧はエントリなし", () => {
    expect(parseSourcesFile("")).toEqual({ entries: [], errors: [] });
    expect(parseSourcesFile("sources: []\n")).toEqual({ entries: [], errors: [] });
  });

  it("不正な行はエラーにして、正しい行だけ返す", () => {
    const { entries, errors } = parseSourcesFile(
      yaml(`
sources:
  - name: OK
    url: https://example.jp/ok
    prefecture: 香川県
  - url: https://example.jp/no-name
    prefecture: 香川県
  - name: 不正な URL
    url: ftp://example.jp/x
    prefecture: 香川県
  - name: 都道府県名が不正
    url: https://example.jp/pref
    prefecture: 香川
  - name: 種別が不正
    url: https://example.jp/type
    prefecture: 香川県
    type: excel
  - name: policy が不正
    url: https://example.jp/policy
    prefecture: 香川県
    policy:
      status: maybe
`),
    );
    expect(entries.map((e) => e.name)).toEqual(["OK"]);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toMatch(/sources\[1\].*name/);
    expect(errors[1]).toMatch(/sources\[2\].*url/);
    expect(errors[2]).toMatch(/sources\[3\].*prefecture/);
    expect(errors[3]).toMatch(/sources\[4\].*type/);
    expect(errors[4]).toMatch(/sources\[5\].*policy/);
  });

  it("URL の重複はエラー（2 つ目以降を落とす）", () => {
    const { entries, errors } = parseSourcesFile(
      yaml(`
sources:
  - name: A
    url: https://example.jp/same
    prefecture: 香川県
  - name: B
    url: https://example.jp/same
    prefecture: 香川県
`),
    );
    expect(entries.map((e) => e.name)).toEqual(["A"]);
    expect(errors).toEqual([expect.stringMatching(/sources\[1\].*重複/)]);
  });

  it("トップレベルの形が違えばエラー", () => {
    expect(parseSourcesFile("- a\n- b\n").errors).toEqual([expect.stringMatching(/sources/)]);
    expect(parseSourcesFile("sources: 1\n").errors).toEqual([expect.stringMatching(/sources/)]);
  });

  it("YAML として読めなければエラー", () => {
    const { entries, errors } = parseSourcesFile("sources: [\n");
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("inferSourceType（type 省略時の推測）", () => {
  it.each([
    ["https://example.jp/a/flyer.pdf", "pdf"],
    ["https://example.jp/a/FLYER.PDF?v=2", "pdf"],
    ["https://example.jp/cal.ics", "ical"],
    ["https://example.jp/feed.rss", "rss"],
    ["https://example.jp/rss.xml", "rss"],
    ["https://example.jp/feed/", "rss"],
    ["https://example.jp/events/", "html"],
  ])("%s → %s", (url, type) => {
    expect(inferSourceType(url)).toBe(type);
  });
});
