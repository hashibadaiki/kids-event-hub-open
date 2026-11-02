/**
 * 全角英数・記号を半角に寄せ、範囲を表す記号（〜 ～ ~ ‐ − など）を "~" に揃える。
 * 抽出結果のゆれを小さくしてから各正規化処理にかけるための前処理。
 */
export function toHalfWidth(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[〜⁓∼‐-―−]/g, "~")
    .replace(/\s+/g, " ")
    .trim();
}
