import { toHalfWidth } from "./text";

/** カテゴリ ID → 表示ラベルと判定キーワード。並び順は同点時の優先順 */
export const CATEGORIES = {
  craft: { label: "工作", keywords: ["工作", "クラフト", "ものづくり", "手作り", "手づくり", "木工", "作ろう", "つくろう", "折り紙", "ワークショップ"] },
  nature: { label: "自然", keywords: ["自然", "昆虫", "虫", "森", "里山", "生き物", "いきもの", "植物", "観察", "星空", "天体", "野鳥", "川遊び", "磯", "落ち葉", "木の実", "キャンプ"] },
  sports: { label: "スポーツ", keywords: ["スポーツ", "サッカー", "野球", "水泳", "体操", "かけっこ", "運動", "陸上", "バスケ", "テニス", "卓球", "ボール", "ダンス"] },
  show: { label: "ショー", keywords: ["ショー", "人形劇", "劇", "公演", "ミュージカル", "マジック", "上演", "上映", "映画"] },
  storytelling: { label: "読み聞かせ", keywords: ["読み聞かせ", "よみきかせ", "おはなし会", "お話し会", "お話会", "絵本", "紙芝居", "ストーリーテリング"] },
  science: { label: "科学", keywords: ["科学", "実験", "サイエンス", "プログラミング", "ロボット", "理科"] },
  music: { label: "音楽", keywords: ["音楽", "コンサート", "演奏", "楽器", "リトミック", "合唱"] },
  cooking: { label: "料理", keywords: ["料理", "クッキング", "お菓子作り", "食育", "調理"] },
  festival: { label: "祭り", keywords: ["祭", "まつり", "フェスタ", "フェス", "縁日", "マルシェ"] },
  other: { label: "その他", keywords: [] },
} as const satisfies Record<string, { label: string; keywords: readonly string[] }>;

export type Category = keyof typeof CATEGORIES;

const TITLE_WEIGHT = 2;

/**
 * タイトル（と説明文）のキーワードでカテゴリを判定する。
 * 該当したカテゴリをスコアの高い順に返す。どれにも当たらなければ ["other"]。
 */
export function classifyCategory(title: string, description = ""): Category[] {
  const t = toHalfWidth(title);
  const d = toHalfWidth(description);
  const scored: { category: Category; score: number }[] = [];
  for (const [category, { keywords }] of Object.entries(CATEGORIES) as [Category, (typeof CATEGORIES)[Category]][]) {
    let score = 0;
    for (const kw of keywords) {
      if (t.includes(kw)) score += TITLE_WEIGHT;
      if (d.includes(kw)) score += 1;
    }
    if (score > 0) scored.push({ category, score });
  }
  if (scored.length === 0) return ["other"];
  // Array.prototype.sort は安定ソートなので同点は CATEGORIES の順
  return scored.sort((a, b) => b.score - a.score).map((s) => s.category);
}
