/**
 * 収集元ごとの抽出設定（extraction_configs.config）。自動改善ループで Claude が提案し、検証して良ければ採用する。
 * - instructions: システムプロンプトに足す、そのページ向けの指示
 * - hints: 箇条書きで足すヒント
 * - selectors: 本文を絞る CSS セレクタの候補。どれにも一致しなければページ全体を使う
 */
export type ExtractionConfig = {
  instructions?: string;
  hints?: string[];
  selectors?: string[];
};

const MAX_TEXT = 2000;
const MAX_ITEMS = 10;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null).slice(0, MAX_ITEMS) : [];

/** DB の JSON や Claude の出力から設定を読む。不正な値は捨てる */
export function parseExtractionConfig(value: unknown): ExtractionConfig {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const out: ExtractionConfig = {};
  const instructions = str(o.instructions);
  if (instructions) out.instructions = instructions;
  const hints = strs(o.hints);
  if (hints.length > 0) out.hints = hints;
  const selectors = strs(o.selectors);
  if (selectors.length > 0) out.selectors = selectors;
  return out;
}
