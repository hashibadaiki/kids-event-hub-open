import { Layout } from "./layout";
import type { EventRecord } from "../repository";
import { raw } from "hono/html";
import { addDays, MAX_AGE, MAX_KEYWORD_LENGTH, MAX_RANGE_DAYS, searchPath, type SearchQuery } from "../search";
import { DATE_VALIDATION_SCRIPT } from "./date-validation";
import { formatAge, formatDateShort, formatPrice, formatRange, formatWhen } from "../format";

export function ListPage(props: { url: string; query: SearchQuery; today: string; events: EventRecord[] }) {
  const { query: q, events } = props;
  const keywordLabel = q.keyword ? `「${q.keyword}」の` : "";
  const heading = `${q.prefecture} ${formatRange(q.from, q.to)}の${keywordLabel}子どもイベント`;
  const ageLabel = q.age !== undefined ? `（${q.age}歳向け）` : "";
  const description = `${heading}${ageLabel}。${events.length}件。`;
  // 日付のショートカット（今日から 7 日分）
  const days = Array.from({ length: 7 }, (_, i) => addDays(props.today, i));

  return (
    <Layout title={`${heading}${ageLabel}`} description={description} url={props.url}>
      <h1>{heading}</h1>
      <nav class="days" aria-label="日付">
        {days.map((d) => (
          <a href={searchPath({ slug: q.slug, from: d, to: d, age: q.age, keyword: q.keyword })}>{formatDateShort(d)}</a>
        ))}
      </nav>
      <form
        class="filter"
        method="get"
        action={`/${q.slug}`}
        data-max-days={String(MAX_RANGE_DAYS)}
        data-today={props.today}
      >
        <label>
          いつから
          <input type="date" name="from" value={q.from} />
        </label>
        <label>
          いつまで
          <input type="date" name="to" value={q.to} />
        </label>
        <label>
          子どもの年齢
          <select name="age">
            <option value="">指定なし</option>
            {Array.from({ length: MAX_AGE + 1 }, (_, a) => (
              <option value={String(a)} selected={q.age === a}>
                {a}歳
              </option>
            ))}
          </select>
        </label>
        <label>
          施設・キーワード
          <input
            type="search"
            name="q"
            value={q.keyword ?? ""}
            maxlength={MAX_KEYWORD_LENGTH}
            placeholder="例: 図書館"
          />
        </label>
        <button type="submit">さがす</button>
      </form>
      <script>{raw(DATE_VALIDATION_SCRIPT)}</script>
      {events.length === 0 ? (
        <p>条件に合うイベントは見つかりませんでした。</p>
      ) : (
        <>
          <p class="muted">{events.length}件</p>
          <ul class="events">
            {events.map((e) => (
              <li>
                <a class="title" href={`/events/${e.id}`}>
                  {e.title}
                </a>
                <div>{formatWhen(e)}</div>
                <div class="muted">
                  {[[e.city, e.venue].filter(Boolean).join(" "), formatAge(e), formatPrice(e)].filter(Boolean).join(" / ")}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Layout>
  );
}
