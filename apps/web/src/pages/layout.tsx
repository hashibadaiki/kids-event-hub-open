import type { Child } from "hono/jsx";
import { raw } from "hono/html";

export const SITE_NAME = "こどもイベントさがし";

const STYLE = `
:root{color-scheme:light;--fg:#2d2a26;--muted:#6b6257;--bg:#fff;--card:#fff8ef;--line:#a38c6b;--accent:#c2410c;--accent-press:#9a3412}
*{box-sizing:border-box}
html{-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%}
a,button{touch-action:manipulation}
button{-webkit-user-select:none;user-select:none}
body{margin:0;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.6;color:var(--fg);background:var(--bg)}
header,main,footer{max-width:40rem;margin:0 auto;padding:0 16px}
header{padding-top:12px}
header a{color:inherit;text-decoration:none;font-weight:700}
h1{font-size:1.3rem;margin:.75rem 0;overflow-wrap:anywhere}
a{color:var(--accent)}
.muted{color:var(--muted);font-size:.9rem}
ul.events,ul.prefs{list-style:none;padding:0;margin:0}
ul.events li{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px;margin:0 0 10px}
ul.events li a.title{font-weight:700;font-size:1.05rem;text-decoration:none}
ul.prefs{display:grid;grid-template-columns:repeat(auto-fill,minmax(9rem,1fr));gap:8px}
ul.prefs a{display:block;padding:12px;border:1px solid var(--line);border-radius:10px;text-decoration:none;background:var(--card)}
form.filter{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0 0 16px;padding:12px;border:1px solid var(--line);border-radius:10px}
form.filter label{display:flex;flex-direction:column;font-size:.85rem;color:var(--muted)}
form.filter input,form.filter select,form.filter button{font:inherit;width:100%;min-width:0;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);min-height:44px}
form.filter input,form.filter select{font-size:16px}
form.filter button{grid-column:1/-1;background:var(--accent);color:#fff;border:0;font-weight:700}
nav.days{display:flex;gap:8px;overflow-x:auto;margin:0 0 12px}
nav.days a{white-space:nowrap;padding:6px 10px;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:.9rem}
dl.detail{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px}
dl.detail dt{color:var(--muted)}
dl.detail dd{margin:0;overflow-wrap:anywhere}
a.back{display:inline-block;margin:12px 0 0;text-decoration:none}
ul.more{padding-left:1.2em}
a.source{display:block;text-align:center;padding:12px;border-radius:10px;background:var(--accent);color:#fff;font-weight:700;text-decoration:none;margin:16px 0}
footer{margin-top:24px;padding-bottom:24px}
section.mcp{margin-top:32px;padding-top:8px;border-top:1px solid var(--line)}
section.mcp h2{font-size:1.1rem}
section.mcp h3{font-size:1rem;margin:16px 0 4px}
section.mcp ol{padding-left:1.2em;margin:4px 0 8px}
div.copy{display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
div.copy code{flex:1;min-width:0;overflow-wrap:anywhere;font-size:.85rem}
div.copy button{flex-shrink:0;font:inherit;font-size:.85rem;padding:6px 12px;min-height:44px;border-radius:8px;border:0;background:var(--accent);color:#fff;font-weight:700;white-space:nowrap}
form.filter button:active,a.source:active,div.copy button:active{background:var(--accent-press)}
ul.prefs a:active,ul.events li:active,nav.days a:active{border-color:var(--accent)}
`;

export function Layout(props: {
  title: string;
  description: string;
  url: string;
  ogType?: "website" | "article";
  children: Child;
}) {
  const fullTitle = `${props.title} | ${SITE_NAME}`;
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>{fullTitle}</title>
        <meta name="description" content={props.description} />
        <link rel="canonical" href={props.url} />
        <meta property="og:site_name" content={SITE_NAME} />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={props.description} />
        <meta property="og:url" content={props.url} />
        <meta property="og:type" content={props.ogType ?? "website"} />
        <meta property="og:locale" content="ja_JP" />
        <meta name="twitter:card" content="summary" />
        <style>{raw(STYLE)}</style>
      </head>
      <body>
        <header>
          <a href="/">{SITE_NAME}</a>
        </header>
        <main>{props.children}</main>
        <footer class="muted">
          <p>自治体・公共施設などの公開情報から自動で集めています。内容は必ず掲載元でご確認ください。</p>
          <p>
            <a href="https://github.com/hashibadaiki/kids-event-hub-open">GitHub</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
