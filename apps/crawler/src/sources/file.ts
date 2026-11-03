import { parse } from "yaml";
import { POLICY_STATUSES, SOURCE_TYPES } from "@kids-event-hub/db";

export type SourceType = (typeof SOURCE_TYPES)[number];
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** sources.yaml の 1 行（検証済み） */
export type SourceEntry = {
  name: string;
  url: string;
  prefecture: string;
  type: SourceType;
  enabled: boolean;
  /** メモ。ファイルにだけ残し、D1 には入れない */
  note: string | null;
  /** robots.txt・利用規約の確認結果。null は「ファイルでは指定しない」（D1 の値を残す） */
  policy: { status: PolicyStatus; checkedAt: string | null; note: string | null } | null;
};

/** events.prefecture / sources.prefecture に入る正式名 */
export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const;

/** type を省略したときの推測。迷ったら html（クローラー側で中身を見て判断する） */
export function inferSourceType(url: string): SourceType {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".pdf")) return "pdf";
  if (path.endsWith(".ics")) return "ical";
  if (/\.(rss|atom)$/.test(path) || /(^|\/)(rss|atom|feed)(\.xml)?\/?$/.test(path)) return "rss";
  return "html";
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const optionalString = (v: unknown): string | null | undefined => {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (v instanceof Date) return v.toISOString().slice(0, 10); // checked_at: 2026-11-03 のようにクォートなしで書いた場合
  return undefined; // 型が違う
};

function parseEntry(raw: unknown): { entry: SourceEntry } | { error: string } {
  if (!isObject(raw)) return { error: "name / url / prefecture を持つオブジェクトにしてください" };

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { error: "name がありません" };

  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    // 下でエラーにする
  }
  if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
    return { error: `url が http(s) の URL ではありません: ${String(raw.url)}` };
  }

  const prefecture = typeof raw.prefecture === "string" ? raw.prefecture.trim() : "";
  if (!(PREFECTURES as readonly string[]).includes(prefecture)) {
    return { error: `prefecture は「香川県」のような正式名で書いてください: ${String(raw.prefecture)}` };
  }

  let type: SourceType;
  if (raw.type === undefined || raw.type === null) {
    type = inferSourceType(url);
  } else if ((SOURCE_TYPES as readonly unknown[]).includes(raw.type)) {
    type = raw.type as SourceType;
  } else {
    return { error: `type は ${SOURCE_TYPES.join(" / ")} のどれかです: ${String(raw.type)}` };
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { error: "enabled は true / false です" };
  }
  const enabled = raw.enabled ?? true;

  const note = optionalString(raw.note);
  if (note === undefined) return { error: "note は文字列です" };

  let policy: SourceEntry["policy"] = null;
  if (raw.policy !== undefined && raw.policy !== null) {
    const p = raw.policy;
    if (!isObject(p) || !(POLICY_STATUSES as readonly unknown[]).includes(p.status)) {
      return { error: `policy.status は ${POLICY_STATUSES.join(" / ")} のどれかです` };
    }
    const checkedAt = optionalString(p.checked_at);
    const policyNote = optionalString(p.note);
    if (checkedAt === undefined || policyNote === undefined) {
      return { error: "policy.checked_at / policy.note は文字列です" };
    }
    policy = { status: p.status as PolicyStatus, checkedAt, note: policyNote };
  }

  return { entry: { name, url, prefecture, type, enabled, note, policy } };
}

/**
 * sources.yaml を読んで検証する。不正な行はエラーに入れて飛ばし、正しい行だけ返す。
 * 同期コマンドはエラーが 1 つでもあれば D1 に触らない
 */
export function parseSourcesFile(text: string): { entries: SourceEntry[]; errors: string[] } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { entries: [], errors: [`YAML として読めません: ${(e as Error).message}`] };
  }
  if (doc === null || doc === undefined) return { entries: [], errors: [] };
  if (!isObject(doc) || !(doc.sources === null || doc.sources === undefined || Array.isArray(doc.sources))) {
    return { entries: [], errors: ["トップレベルは `sources:` の配列にしてください"] };
  }

  const entries: SourceEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  (doc.sources ?? []).forEach((raw: unknown, i: number) => {
    const result = parseEntry(raw);
    if ("error" in result) {
      errors.push(`sources[${i}]: ${result.error}`);
    } else if (seen.has(result.entry.url)) {
      errors.push(`sources[${i}]: url が重複しています: ${result.entry.url}`);
    } else {
      seen.add(result.entry.url);
      entries.push(result.entry);
    }
  });
  return { entries, errors };
}
