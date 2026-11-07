import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { dashboardStats } from "@kids-event-hub/db";
import type { EventRepository } from "./repository";
import { parseSearch, todayJst } from "./search";
import { prefectureByName, PREFECTURES } from "./prefectures";
import { HomePage } from "./pages/home";
import { ListPage } from "./pages/list";
import { DetailPage } from "./pages/detail";
import { handleMcp } from "./mcp/server";

export type Bindings = { DB: D1Database };

export type AppOptions = {
  repository: (env: Bindings) => EventRepository;
  now?: () => Date;
};

const DOCTYPE = "<!DOCTYPE html>";

export function createApp({ repository, now = () => new Date() }: AppOptions) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/healthz/db", async (c) => {
    const row = await c.env.DB.prepare("SELECT 1 AS db").first<{ db: number }>();
    return c.json({ ok: true, db: row?.db ?? 0 });
  });

  // 運用ダッシュボード（Claude の Dashboard）が読む集計。読み取り専用・公開してよい数字のみ
  app.get("/api/dashboard", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const runLimit = parseLimit(params.get("runs"));
    const failureLimit = parseLimit(params.get("failures"));
    if (runLimit === null || failureLimit === null) {
      return c.text("Bad Request: runs / failures は 1〜200 の整数", 400);
    }
    const stats = await dashboardStats(drizzle(c.env.DB), { runLimit, failureLimit });
    return c.json({ generatedAt: now().toISOString(), ...stats }, 200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    });
  });

  // MCP サーバー（Streamable HTTP、読み取りのツールのみ）
  app.post("/mcp", async (c) => {
    const res = await handleMcp(await c.req.text(), {
      repository: repository(c.env),
      now: now(),
      origin: new URL(c.req.url).origin,
      dashboard: (options) => dashboardStats(drizzle(c.env.DB), options),
    });
    if (res.body === undefined) return c.body(null, res.status as 202);
    return c.json(res.body, res.status as 200 | 400);
  });
  // サーバーから送る通知はないので、GET の SSE ストリームとセッション削除は提供しない
  app.on(["GET", "DELETE"], "/mcp", (c) => c.text("Method Not Allowed", 405, { Allow: "POST" }));

  // 都道府県一覧（データがある県だけ、北から順）
  app.get("/", async (c) => {
    const counts = new Map((await repository(c.env).prefectures()).map((p) => [p.prefecture, p.count]));
    const prefectures = PREFECTURES.filter((p) => counts.has(p.name)).map((p) => ({
      ...p,
      count: counts.get(p.name)!,
    }));
    return c.html(DOCTYPE + (<HomePage url={c.req.url} mcpUrl={new URL("/mcp", c.req.url).href} prefectures={prefectures} />));
  });

  app.get("/events/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) return c.notFound();
    const event = await repository(c.env).findById(Number(id));
    if (!event) return c.notFound();
    return c.html(
      DOCTYPE + (<DetailPage url={c.req.url} event={event} prefecture={prefectureByName(event.prefecture)} />),
    );
  });

  const list = async (c: Context<{ Bindings: Bindings }>, date?: string) => {
    const at = now();
    const parsed = parseSearch({
      prefecture: c.req.param("pref") ?? "",
      date,
      params: new URL(c.req.url).searchParams,
      now: at,
    });
    if (!parsed.ok) {
      return parsed.status === 404 ? c.notFound() : c.text(`Bad Request: ${parsed.reason}`, 400);
    }
    const events = await repository(c.env).search(parsed.query);
    return c.html(
      DOCTYPE + (<ListPage url={c.req.url} query={parsed.query} today={todayJst(at)} events={events} />),
    );
  };

  app.get("/:pref", (c) => list(c));
  app.get("/:pref/:date", (c) => list(c, c.req.param("date")));

  return app;
}

const MAX_LIMIT = 200;

/** 件数パラメータ。未指定は undefined（既定値）、不正は null */
function parseLimit(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= MAX_LIMIT ? n : null;
}
