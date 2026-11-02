import { Hono } from "hono";

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.text("kids-event-hub"));
app.get("/healthz", (c) => c.json({ ok: true }));
app.get("/healthz/db", async (c) => {
  const row = await c.env.DB.prepare("SELECT 1 AS db").first<{ db: number }>();
  return c.json({ ok: true, db: row?.db ?? 0 });
});

export default app;
