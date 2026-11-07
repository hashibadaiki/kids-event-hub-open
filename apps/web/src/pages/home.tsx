import { Layout } from "./layout";
import { McpGuide } from "./mcp-guide";
import type { Prefecture } from "../prefectures";

export function HomePage(props: { url: string; mcpUrl: string; prefectures: (Prefecture & { count: number })[] }) {
  return (
    <Layout
      title="都道府県から探す"
      description="子ども向けイベントを都道府県と日付で探せます。自治体・公共施設のチラシから自動で集めています。"
      url={props.url}
    >
      <h1>都道府県から探す</h1>
      {props.prefectures.length === 0 ? (
        <p>まだイベントがありません。</p>
      ) : (
        <ul class="prefs">
          {props.prefectures.map((p) => (
            <li>
              <a href={`/${p.slug}`}>
                {p.name} <span class="muted">{p.count}件</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <McpGuide mcpUrl={props.mcpUrl} />
    </Layout>
  );
}
