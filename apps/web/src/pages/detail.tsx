import { Layout } from "./layout";
import type { EventRecord } from "../repository";
import type { Prefecture } from "../prefectures";
import { formatAge, formatPrice, formatWhen, isPdfUrl } from "../format";
import { searchPath } from "../search";

export function DetailPage(props: { url: string; event: EventRecord; prefecture?: Prefecture }) {
  const e = props.event;
  const pdf = isPdfUrl(e.sourceUrl);
  const where = [e.prefecture, e.city, e.venue].filter(Boolean).join(" ");
  const age = formatAge(e);
  const price = formatPrice(e);
  const day = e.startAt.slice(0, 10);
  return (
    <Layout
      title={e.title}
      description={[formatWhen(e), where, e.summary].filter(Boolean).join(" / ")}
      url={props.url}
      ogType="article"
    >
      <h1>{e.title}</h1>
      <dl class="detail">
        <dt>日時</dt>
        <dd>{formatWhen(e)}</dd>
        <dt>場所</dt>
        <dd>{where}</dd>
        {age && (
          <>
            <dt>対象</dt>
            <dd>{age}</dd>
          </>
        )}
        {price && (
          <>
            <dt>料金</dt>
            <dd>{price}</dd>
          </>
        )}
        {e.categories.length > 0 && (
          <>
            <dt>分類</dt>
            <dd>{e.categories.join("、")}</dd>
          </>
        )}
      </dl>
      {e.summary && <p>{e.summary}</p>}
      <a class="source" href={e.sourceUrl} rel="noopener" target="_blank">
        {pdf ? "PDF チラシを開く" : "掲載元のページを開く"}
      </a>
      <p class="muted">
        {pdf ? "PDF チラシ" : "掲載元のページ"}の内容を要約しています。申込方法や最新情報は掲載元でご確認ください。
      </p>
      {props.prefecture && (
        <p>
          <a href={searchPath({ slug: props.prefecture.slug, from: day, to: day })}>
            {props.prefecture.name}のこの日のイベント一覧へ
          </a>
        </p>
      )}
    </Layout>
  );
}
