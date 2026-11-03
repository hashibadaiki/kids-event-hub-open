import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// migration を適用した D1 に対してテストする（スキーマ定義と migration のずれも検出できる）
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
