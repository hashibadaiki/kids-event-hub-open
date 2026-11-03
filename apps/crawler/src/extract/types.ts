/**
 * 抽出器が返すイベント候補。正規化（packages/core）の前の、元の表記に近い形。
 * - start / end が分かる抽出器（JSON-LD / iCal）は JST ローカル表記で入れる
 * - 分からない抽出器（RSS / HTML）は dateText に日付を含むテキストを入れ、正規化で読む
 */
export type RawEvent = {
  title: string;
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  dateText?: string | null;
  venue?: string | null;
  city?: string | null;
  ageText?: string | null;
  priceText?: string | null;
  priceFree?: boolean | null;
  /** 元の説明文。保存はせず、正規化の手がかりと要約の材料にだけ使う */
  description?: string | null;
  /** Claude が書いた要約（転載ではない） */
  summary?: string | null;
  /** イベント個別ページの URL（絶対 URL） */
  url?: string | null;
};
