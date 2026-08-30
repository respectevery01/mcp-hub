/**
 * mcp.jask.dev — MCP hub aggregating all Jask / UZEN Labs product content.
 *
 * One streamable-HTTP MCP endpoint, read-only, no auth (same policy as
 * theonchaindiary.com/api/mcp). Sources are fetched live from each site's
 * static snapshot with edge caching, so deploys on any source site are
 * picked up automatically within the cache TTL.
 *
 * Sources:
 *   onchaindiary — theonchaindiary.com   (Web3 security, EN/ZH, 316 items)
 *   zensink      — zens.ink              (SEO workflow docs, 4 langs)
 *   blog         — blog.jask.dev         (Jask's personal blog, ZH)
 *   uzenlabs     — uzenlabs.com          (build log + product pages, EN)
 *
 * Tools:
 *   list_sites()                 — overview of all connected sources
 *   search(query, site?, lang?)  — cross-site metadata search
 *   read(site, id)               — full text of one item
 */

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'jask-mcp-hub', version: '1.0.0', title: 'Jask MCP Hub', version_human: 'v1.0' };

interface SourceConfig {
  id: string;
  site: string;
  origin: string;
  kind: string;
  manifest: string;
  full?: string;
  perItem?: { article: string; glossary: string }; // onchaindiary pattern
}

const SOURCES: SourceConfig[] = [
  {
    id: 'onchaindiary',
    site: 'theonchaindiary.com',
    origin: 'https://theonchaindiary.com',
    kind: 'Web3 on-chain security education (articles + glossary, EN/ZH)',
    manifest: 'https://theonchaindiary.com/mcp/manifest.json',
    perItem: { article: 'https://theonchaindiary.com/mcp/a/{id}.json', glossary: 'https://theonchaindiary.com/mcp/glossary/{id}.json' },
  },
  {
    id: 'zensink',
    site: 'zens.ink',
    origin: 'https://zens.ink',
    kind: 'ZensInk SEO workflow docs + journal (EN/ZH/JA/ES)',
    manifest: 'https://zens.ink/mcp/manifest.json',
    full: 'https://zens.ink/mcp/full.json',
  },
  {
    id: 'blog',
    site: 'blog.jask.dev',
    origin: 'https://blog.jask.dev',
    kind: "Jask's personal tech blog (ZH)",
    manifest: 'https://blog.jask.dev/mcp-manifest.json?v=2',
    full: 'https://blog.jask.dev/mcp-full.json?v=2',
  },
  {
    id: 'uzenlabs',
    site: 'uzenlabs.com',
    origin: 'https://uzenlabs.com',
    kind: 'UZEN Labs build log + product pages (EN)',
    manifest: 'https://uzenlabs.com/mcp/manifest.json',
    full: 'https://uzenlabs.com/mcp/full.json',
  },
];

const INSTRUCTIONS = `MCP hub for all Jask / UZEN Labs content: ${SOURCES.map((s) => `${s.site} (${s.kind})`).join('; ')}. Use search() across sites to find relevant pieces (supports EN/ZH keywords), then read(site, id) for full text. Always cite the URL fields in your answers. Source sites update their snapshots on every deploy; this hub refreshes within an hour.`;

const TOOLS = [
  {
    name: 'list_sites',
    description: 'List every content source connected to this hub, with item counts and content types.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search',
    description:
      'Search across all connected sites (Web3 security, SEO docs, blog posts, build logs). Returns top matches with title, site, URL and short description. Use this first to discover content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "wallet drainer", "permit2 钓鱼", "geo score", "cloudflare 实战"' },
        site: { type: 'string', enum: SOURCES.map((s) => s.id), description: 'Optional: restrict to one source' },
        lang: { type: 'string', enum: ['en', 'zh', 'ja', 'es'], description: 'Optional: restrict to one language' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read',
    description:
      'Read the full text of one item. First search() to get the site + id, then call this. Returns raw markdown with metadata header.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: SOURCES.map((s) => s.id), description: 'Which source site' },
        id: { type: 'string', description: 'Item id from search results' },
      },
      required: ['site', 'id'],
    },
  },
];

// ---------------------------------------------------------------- helpers

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Authorization',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra } });

const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: '2.0', id, error: { code, message } }, id === null ? 200 : 400);

const textContent = (text: string, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'jask-mcp-hub/1.0' }, cf: { cacheTtl: 600, cacheEverything: true } } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface ManifestItem {
  type: string;
  lang: string;
  id: string;
  title?: string;
  term?: string;
  zhTerm?: string;
  description?: string;
  url: string;
  tags?: string[];
  pubDate?: string;
  pro?: boolean;
  category?: string;
}
interface Manifest { site: string; kind?: string; updated?: string; items: ManifestItem[]; counts?: Record<string, number> }
interface FullItem { id: string; title?: string; url?: string; lang?: string; content?: string; markdown?: string; pubDate?: string; [k: string]: unknown }

const manifestCache = new Map<string, { at: number; data: Manifest }>();

async function getManifest(src: SourceConfig): Promise<Manifest | null> {
  const hit = manifestCache.get(src.id);
  if (hit && Date.now() - hit.at < 300_000) return hit.data;
  const data = await fetchJson<Manifest>(src.manifest);
  if (data && Array.isArray(data.items)) {
    manifestCache.set(src.id, { at: Date.now(), data });
    return data;
  }
  return hit ? hit.data : null;
}

// ---------------------------------------------------------------- tools

async function toolListSites() {
  const lines: string[] = [];
  for (const src of SOURCES) {
    const m = await getManifest(src);
    const n = m ? m.items.length : '?';
    const langs = m ? [...new Set(m.items.map((i) => i.lang))].sort().join('/') : '?';
    const types = m ? [...new Set(m.items.map((i) => i.type))].sort().join('/') : '?';
    lines.push(`## ${src.site} (site id: "${src.id}")\n- ${src.kind}\n- ${n} items — types: ${types} — langs: ${langs}${m?.updated ? ` — updated ${m.updated}` : ''}\n- Origin: ${src.origin}`);
  }
  return textContent(
    `Jask MCP Hub — ${SOURCES.length} sources connected. Endpoint: https://mcp.jask.dev/mcp\n\n${lines.join('\n\n')}\n\nUse search(query, site?) to find content, read(site, id) for full text.`
  );
}

async function toolSearch(args: Record<string, unknown>) {
  const query = String(args?.query ?? '').trim();
  if (!query) return textContent('Error: query is required.', true);
  const siteFilter = args?.site ? String(args.site) : null;
  const lang = args?.lang ? String(args.lang) : null;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const results: { src: SourceConfig; item: ManifestItem; score: number }[] = [];
  for (const src of SOURCES) {
    if (siteFilter && src.id !== siteFilter) continue;
    const m = await getManifest(src);
    if (!m) continue;
    for (const item of m.items) {
      if (lang && item.lang !== lang) continue;
      const title = (item.type === 'glossary' ? `${item.term ?? ''} ${item.zhTerm ?? ''} ${item.title ?? ''}` : item.title ?? '').toLowerCase();
      const desc = (item.description ?? '').toLowerCase();
      const tags = (item.tags ?? []).join(' ').toLowerCase();
      let score = 0;
      let hits = 0;
      for (const t of tokens) {
        let hit = false;
        if (title.includes(t)) { score += 3; hit = true; }
        if (tags.includes(t)) { score += 2; hit = true; }
        if (desc.includes(t)) { score += 1; hit = true; }
        if (hit) hits++;
      }
      if (hits === tokens.length && score > 0) results.push({ src, item, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 10);
  if (!top.length) {
    return textContent(`No matches for "${query}" across ${siteFilter ? siteFilter : 'all sites'}. Try broader keywords or list_sites().`);
  }
  const lines = top.map(({ src, item }) => {
    const label = item.type === 'glossary'
      ? `${item.term}${item.zhTerm ? ` (${item.zhTerm})` : ''} — ${item.description ?? ''}`
      : `[${src.id}/${item.lang}] ${item.title} (${item.pubDate ?? 'doc'}) — ${item.description ?? ''}`;
    return `- ${label}\n  ${src.origin}${item.url}  (site: ${src.id}, id: ${item.id})`;
  });
  return textContent(`Top ${top.length} result(s) for "${query}":\n\n${lines.join('\n\n')}\n\nUse read(site, id) for full text.`);
}

function normalizeId(raw: unknown): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  s = s.replace(/\.(html?|md|json)$/i, '');
  return s.replace(/^\/+|\/+$/g, '');
}

async function toolRead(args: Record<string, unknown>) {
  const siteId = String(args?.site ?? '').trim();
  const src = SOURCES.find((s) => s.id === siteId);
  if (!src) return textContent(`Error: unknown site "${siteId}". Valid: ${SOURCES.map((s) => s.id).join(', ')}.`, true);
  const id = normalizeId(args?.id);
  if (!id) return textContent('Error: id is required (get it from search results).', true);

  // onchaindiary: per-item shards keyed by manifest type
  if (src.perItem) {
    const m = await getManifest(src);
    const item = m?.items.find((i) => normalizeId(i.id) === id || normalizeId(i.url).endsWith('/' + id));
    const itemType = item?.type === 'glossary' ? 'glossary' : 'article';
    const tpl = itemType === 'glossary' ? src.perItem.glossary : src.perItem.article;
    const shard = await fetchJson<Record<string, unknown>>(tpl.replace('{id}', encodeURIComponent(id)));
    if (!shard) return textContent(`Item not found on ${src.site}: "${id}". Use search(site="${src.id}", ...) for valid ids.`, true);
    const body = (shard.markdown as string) ?? (shard.content as string) ?? '';
    const head = [
      `# ${(shard.term as string) ?? (shard.title as string) ?? id}`,
      '',
      `- Site: ${src.site} | URL: ${src.origin}${(shard.url as string) ?? (item?.url ?? '')}`,
      shard.zhTerm ? `- 中文: ${shard.zhTerm}` : null,
      '',
    ].filter(Boolean).join('\n');
    const zhDef = shard.zhDefinition ? `\n\n## 中文\n**${shard.zhTerm}** — ${shard.zhDefinition}\n中文页面: ${shard.urlZh ?? ''}` : '';
    return textContent(head + body + zhDef);
  }

  // full-snapshot sources
  if (!src.full) return textContent(`Error: source ${src.id} has no full-text snapshot configured.`, true);
  const full = await fetchJson<{ items: FullItem[] }>(src.full);
  if (!full) return textContent(`Error: could not load content snapshot for ${src.site}.`, true);
  const item = full.items.find((i) => normalizeId(i.id) === id || normalizeId(i.url ?? '').endsWith('/' + id));
  if (!item) return textContent(`Item not found on ${src.site}: "${id}". Use search(site="${src.id}", ...) for valid ids.`, true);
  const head = [
    `# ${item.title ?? id}`,
    '',
    `- Site: ${src.site} | URL: ${src.origin}${item.url ?? ''}${item.pubDate ? ` | ${item.pubDate}` : ''}`,
    '',
  ].join('\n');
  return textContent(head + (item.content ?? item.markdown ?? ''));
}

// ---------------------------------------------------------------- protocol

async function handleToolCall(params: { name?: string; arguments?: Record<string, unknown> }) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  try {
    switch (name) {
      case 'list_sites': return await toolListSites();
      case 'search': return await toolSearch(args);
      case 'read': return await toolRead(args);
      default: return textContent(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    return textContent(`Tool error: ${(err as Error)?.message ?? String(err)}`, true);
  }
}

async function handleRpc(request: Request): Promise<Response> {
  let body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error: invalid JSON');
  }
  const { id, method, params } = body;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case 'notifications/initialized':
    case 'initialized':
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      return rpcResult(id, await handleToolCall(params ?? {}));
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------- portal page

function portalPage(): Response {
  const rows = SOURCES.map((s) => {
    const m = manifestCache.get(s.id)?.data;
    const n = m ? String(m.items.length) : '—';
    return `<tr><td><code>${s.id}</code></td><td><a href="${s.origin}" rel="noopener">${s.site}</a></td><td>${s.kind}</td><td class="num">${n}</td></tr>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jask MCP Hub</title>
<meta name="description" content="One MCP endpoint serving all Jask / UZEN Labs product content: Web3 security education, SEO workflow docs, build logs, blog. Read-only, no auth.">
<meta property="og:title" content="Jask MCP Hub">
<meta property="og:description" content="One MCP endpoint for all Jask / UZEN Labs content — Web3 security, SEO docs, build logs, blog.">
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background:#0e1011; color:#d7dde3; font:16px/1.7 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 64px 24px 96px; }
  h1 { color:#f2f6fa; font-size: clamp(28px, 5vw, 40px); letter-spacing: -0.02em; margin-bottom: 8px; }
  h1 .accent { color:#4a9eff; }
  .sub { color:#8b98a5; margin-bottom: 40px; }
  h2 { color:#f2f6fa; font-size: 18px; margin: 40px 0 12px; }
  p { margin-bottom: 12px; }
  table { width:100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1e2429; }
  th { color:#8b98a5; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
  td.num { color:#4a9eff; font-variant-numeric: tabular-nums; }
  a { color:#4a9eff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  pre { background:#14181b; border:1px solid #1e2429; border-radius:8px; padding:16px; overflow:auto; font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; color:#aebac5; }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; color:#4a9eff; font-size: .9em; }
  .ep { display:inline-block; background:#14181b; border:1px solid #1e2429; border-radius:6px; padding:6px 12px; margin: 4px 0 20px; }
  footer { margin-top:64px; color:#5a6672; font-size:13px; border-top:1px solid #1e2429; padding-top:20px; }
</style>
</head>
<body><main>
<h1>Jask <span class="accent">MCP Hub</span></h1>
<p class="sub">One Model Context Protocol endpoint serving every Jask / UZEN Labs product's content. Read-only, no auth.</p>
<span class="ep"><code>https://mcp.jask.dev/mcp</code></span>
<h2>Sources</h2>
<table><tr><th>site id</th><th>site</th><th>content</th><th>items</th></tr>${rows}</table>
<h2>Tools</h2>
<p><code>list_sites()</code> — overview of connected sources<br>
<code>search(query, site?, lang?)</code> — cross-site keyword search (EN/ZH)<br>
<code>read(site, id)</code> — full text of one item as markdown</p>
<h2>Try it</h2>
<pre>curl https://mcp.jask.dev/mcp \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# then search + read
curl https://mcp.jask.dev/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"search","arguments":{"query":"wallet drainer"}}}'</pre>
<h2>Use with an MCP client</h2>
<pre>{
  "mcpServers": {
    "jask": {
      "type": "http",
      "url": "https://mcp.jask.dev/mcp"
    }
  }
}</pre>
<footer>Content snapshots update automatically when source sites deploy. Individual endpoints: <a href="https://theonchaindiary.com/api/mcp">onchain diary</a> · <a href="https://jask.dev/mcp">about this hub</a></footer>
</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' } });
}

function wellKnown(): Response {
  return json({
    servers: [
      {
        name: 'jask-mcp-hub',
        title: 'Jask MCP Hub',
        description: 'All Jask / UZEN Labs product content in one MCP endpoint: Web3 security (Onchain Diary), SEO workflow docs (ZensInk), build logs (UZEN Labs), personal blog.',
        transport: 'streamable-http',
        url: 'https://mcp.jask.dev/mcp',
        auth: 'none',
        tools: ['list_sites', 'search', 'read'],
      },
    ],
  });
}

// ---------------------------------------------------------------- entry

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // warm manifests so item counts render on first visit
      await Promise.allSettled(SOURCES.map((s) => getManifest(s)));
      return portalPage();
    }
    if (url.pathname === '/.well-known/mcp.json') return wellKnown();
    if (url.pathname === '/sites.json') {
      const sites = await Promise.all(
        SOURCES.map(async (s) => {
          const m = await getManifest(s);
          return {
            id: s.id, site: s.site, origin: s.origin, kind: s.kind,
            items: m ? m.items.length : 0,
            langs: m ? [...new Set(m.items.map((i) => i.lang))].sort() : [],
            types: m ? [...new Set(m.items.map((i) => i.type))].sort() : [],
            updated: m?.updated ?? null,
          };
        }),
      );
      return json({ hub: 'https://mcp.jask.dev/mcp', sites, total: sites.reduce((a, b) => a + b.items, 0) });
    }
    if (url.pathname === '/mcp' || url.pathname === '/api/mcp') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed. MCP endpoint accepts POST (JSON-RPC 2.0). Docs: https://mcp.jask.dev/', {
          status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS },
        });
      }
      return handleRpc(request);
    }
    return new Response('Not Found. See https://mcp.jask.dev/ — MCP endpoint at /mcp', { status: 404, headers: CORS_HEADERS });
  },
};
