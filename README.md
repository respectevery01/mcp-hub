# Jask MCP Hub — mcp.jask.dev

One Model Context Protocol (MCP) endpoint aggregating all Jask / UZEN Labs
product content. Read-only, no auth, streamable HTTP.

**Endpoint:** `https://mcp.jask.dev/mcp`

## Sources

| site id | site | content |
|---|---|---|
| `onchaindiary` | theonchaindiary.com | Web3 on-chain security education (articles + glossary, EN/ZH) |
| `zensink` | zens.ink | ZensInk SEO workflow docs + journal (EN/ZH/JA/ES) |
| `blog` | blog.jask.dev | Jask's personal tech blog (ZH) |
| `uzenlabs` | uzenlabs.com | UZEN Labs build log + product pages (EN) |

## Tools

- `list_sites()` — overview of connected sources
- `search(query, site?, lang?)` — cross-site keyword search
- `read(site, id)` — full text of one item as markdown

## Architecture

Each source site publishes static JSON snapshots at deploy time
(`/mcp/manifest.json` + `/mcp/full.json`, or per-item shards for onchaindiary).
This Worker fetches them with 1h edge caching — source deploys propagate
automatically. No database, no state.

- Source snapshot specs: see each site's repo (`wytblog` Hugo output formats,
  `zens-ink-site` / `uzen` Astro endpoints, `astro-onchaindiary` per-item shards).
- Per-source MCP endpoints remain live and independent (e.g.
  `theonchaindiary.com/api/mcp`); the hub is an additive aggregation layer.

## Deploy

Git push to `main` (GitHub Actions → `wrangler deploy`). Custom domain
`mcp.jask.dev` is bound via `wrangler.jsonc` routes.

## Local dev

```
npx wrangler dev
```
