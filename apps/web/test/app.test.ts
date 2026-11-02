import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import app from "../src/index";

describe("web app", () => {
  it("GET /healthz returns ok", async () => {
    const res = await app.request("/healthz", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /healthz/db reaches D1", async () => {
    const res = await app.request("/healthz/db", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: 1 });
  });
});
