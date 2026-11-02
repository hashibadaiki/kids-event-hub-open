import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { crawlTargets } from "../src/queries";
import { sources } from "../src/schema";

const db = drizzle(env.DB);

beforeEach(async () => {
  for (const t of ["events", "crawl_runs", "extraction_configs", "sources", "facilities"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function insertSource(overrides: Partial<typeof sources.$inferInsert>) {
  await db.insert(sources).values({
    name: "x",
    url: `https://example.jp/${crypto.randomUUID()}`,
    type: "html",
    prefecture: "香川県",
    ...overrides,
  });
}

describe("crawlTargets", () => {
  it("approved・有効・policy が ng でない行だけを id 順に返す", async () => {
    await insertSource({ name: "ok", status: "approved", policyStatus: "ok" });
    await insertSource({ name: "unchecked", status: "approved" });
    await insertSource({ name: "caution", status: "approved", policyStatus: "caution" });
    await insertSource({ name: "ng", status: "approved", policyStatus: "ng" });
    await insertSource({ name: "pending", status: "pending", policyStatus: "ok" });
    await insertSource({ name: "rejected", status: "rejected", policyStatus: "ok" });
    await insertSource({ name: "disabled", status: "approved", policyStatus: "ok", enabled: false });
    const rows = await crawlTargets(db);
    expect(rows.map((r) => r.name)).toEqual(["ok", "unchecked", "caution"]);
  });
});
