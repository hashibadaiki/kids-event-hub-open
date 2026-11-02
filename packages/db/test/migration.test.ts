import { describe, it, expect } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

describe("migration", () => {
  it("雛形の sources に行がある状態からでも移行でき、旧行は pending（クロール対象外）になる", async () => {
    const [first, ...rest] = env.TEST_MIGRATIONS;
    await applyD1Migrations(env.LEGACY_DB, [first]);
    await env.LEGACY_DB.prepare(
      "INSERT INTO sources (name, url, prefecture) VALUES ('旧', 'https://example.jp/old', '香川県')",
    ).run();

    await applyD1Migrations(env.LEGACY_DB, [first, ...rest]);

    const row = await env.LEGACY_DB.prepare("SELECT * FROM sources WHERE url = 'https://example.jp/old'").first();
    expect(row).toMatchObject({ name: "旧", prefecture: "香川県", type: "html", status: "pending", enabled: 1 });
    const fk = await env.LEGACY_DB.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
  });
});
