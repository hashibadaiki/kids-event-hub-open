import { raw } from "hono/html";

const COPY_SCRIPT = `(() => {
  for (const button of document.querySelectorAll("button[data-copy]")) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const label = button.textContent;
      try {
        await navigator.clipboard.writeText(button.getAttribute("data-copy"));
        button.textContent = "コピーしました";
      } catch {
        button.textContent = "コピーできませんでした";
      }
      setTimeout(() => (button.textContent = label), 2000);
    });
  }
})();`;

function CopyBlock(props: { text: string }) {
  return (
    <div class="copy">
      <code>{props.text}</code>
      <button type="button" data-copy={props.text} hidden>
        コピー
      </button>
    </div>
  );
}

export function McpGuide(props: { mcpUrl: string }) {
  const command = `claude mcp add --transport http kids-event-hub ${props.mcpUrl}`;
  return (
    <section class="mcp">
      <h2>AI アシスタントから使う</h2>
      <p class="muted">
        MCP サーバーを公開しています。Claude に登録すると「今週末、香川で3歳の子と行けるイベントは？」のように聞けます。
      </p>
      <h3>claude.ai / Claude Desktop</h3>
      <ol>
        <li>
          <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">
            コネクタ設定
          </a>
          を開き「カスタムコネクタを追加」を選ぶ
        </li>
        <li>名前は好きなもので構いません（例: こどもイベントさがし）</li>
        <li>URL 欄に、下の URL を貼り付けて追加する</li>
      </ol>
      <CopyBlock text={props.mcpUrl} />
      <h3>Claude Code</h3>
      <p class="muted">ターミナルで実行します。</p>
      <CopyBlock text={command} />
      <script>{raw(COPY_SCRIPT)}</script>
    </section>
  );
}
