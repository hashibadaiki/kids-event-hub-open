import { describe, it, expect } from "vitest";
import { parseSyncArgs, runSyncSources, type SyncDeps } from "../src/sources/cli";

const YAML = `
sources:
  - name: 高松市こども未来館
    url: https://example.jp/miraikan.pdf
    prefecture: 香川県
`;

/** wrangler の呼び出しを記録するモック。SELECT には `existing` を JSON で返す */
function fakeDeps(yamlText: string, existing: unknown[] = []) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const files: Record<string, string> = {};
  const deps: SyncDeps = {
    readSourcesFile: () => yamlText,
    wrangler: (args) => {
      calls.push(args);
      if (args.includes("--command")) return JSON.stringify([{ results: existing, success: true }]);
      return "";
    },
    writeTempFile: (content) => {
      const path = `/tmp/sync-${Object.keys(files).length}.sql`;
      files[path] = content;
      return path;
    },
    log: (line) => logs.push(line),
  };
  return { deps, calls, logs, files };
}

describe("parseSyncArgs", () => {
  it("既定はローカル D1。--remote / --dry-run / --file", () => {
    expect(parseSyncArgs([])).toEqual({ remote: false, dryRun: false, file: null });
    expect(parseSyncArgs(["--remote", "--dry-run", "--file", "x.yaml"])).toEqual({
      remote: true,
      dryRun: true,
      file: "x.yaml",
    });
  });

  it("知らない引数はエラー", () => {
    expect(() => parseSyncArgs(["--force"])).toThrow(/--force/);
  });
});

describe("runSyncSources", () => {
  it("D1 の現状を読み、SQL ファイルを作って wrangler で実行する（ローカル）", async () => {
    const { deps, calls, files } = fakeDeps(YAML);
    const code = await runSyncSources({ remote: false, dryRun: false, file: null }, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining(["d1", "execute", "kids-event-hub", "--local", "--json", "--command"]));
    expect(calls[1]).toEqual(["d1", "execute", "kids-event-hub", "--local", "--file", "/tmp/sync-0.sql"]);
    expect(files["/tmp/sync-0.sql"]).toMatch(/INSERT INTO sources/);
    expect(calls.flat()).not.toContain("--remote");
  });

  it("--remote のときだけ本番 D1 を指定する", async () => {
    const { deps, calls } = fakeDeps(YAML);
    await runSyncSources({ remote: true, dryRun: false, file: null }, deps);
    expect(calls.every((c) => c.includes("--remote") && !c.includes("--local"))).toBe(true);
  });

  it("--dry-run は書き込まず、計画と SQL を表示する", async () => {
    const { deps, calls, logs } = fakeDeps(YAML);
    const code = await runSyncSources({ remote: false, dryRun: true, file: null }, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1); // SELECT のみ
    expect(logs.join("\n")).toMatch(/追加 1/);
    expect(logs.join("\n")).toMatch(/INSERT INTO sources/);
  });

  it("ファイルにエラーがあれば D1 に触らず終了コード 1", async () => {
    const { deps, calls, logs } = fakeDeps("sources:\n  - name: x\n");
    const code = await runSyncSources({ remote: false, dryRun: false, file: null }, deps);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toMatch(/url/);
  });

  it("スキップした行（施設投稿と同じ URL）は理由を表示する", async () => {
    const { deps, logs } = fakeDeps(YAML, [
      { url: "https://example.jp/miraikan.pdf", submitted_by: "facility", enabled: 1 },
    ]);
    const code = await runSyncSources({ remote: false, dryRun: false, file: null }, deps);
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/スキップ.*miraikan\.pdf/);
  });

  it("実行する SQL がなければ書き込みの wrangler は呼ばない", async () => {
    const { deps, calls } = fakeDeps("sources: []\n");
    const code = await runSyncSources({ remote: false, dryRun: false, file: null }, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("D1 の読み取りに失敗したら終了コード 1（migration 未適用など）", async () => {
    const { deps, logs } = fakeDeps(YAML);
    deps.wrangler = () => {
      throw new Error("no such table: sources");
    };
    const code = await runSyncSources({ remote: false, dryRun: false, file: null }, deps);
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/migrations apply/);
  });
});
