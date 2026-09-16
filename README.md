# sec-insider

SEC **Forms 3/4/5** — insider transactions, hosted so the question can be inverted.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Why this is hosted

Every insider API is company-first, ours included: you pass an issuer and get its
Form 4s. *"Which insiders bought the most last week, anywhere"* has no filer to
start from — the aggregation is across all issuers at once — so no upstream can
answer it. A flat table makes it one indexed query.

## Tools

- `insider_top_buyers({since?, until?, min_value_usd?, limit?})` — biggest
  open-market purchases across every issuer, by dollar value.
- `insider_top_sellers({…})` — the same for sales.
- `insider_coverage()` — which quarterly releases are loaded and what counts as
  buying. Check this before trusting a ranking.

## The transaction code is the whole meaning of a row

In the loaded window, 182,061 transactions break down as:

| code | meaning | rows |
|---|---|---|
| S | open-market sale | 27,601 |
| A | grant or award | 19,211 |
| M | option / derivative exercise | 10,783 |
| F | shares withheld for tax | 9,357 |
| **P** | **open-market purchase** | **11,261** |

Only **P** is someone deciding to buy at market. A grant is compensation and an
exercise is a conversion. A "biggest buyers" ranking that counts A or M puts
insiders who bought nothing at the top, which is why this pack filters to P and
says so in every response.

## Two things about the data

**Dates are filer-supplied and sometimes wrong.** The loaded window holds 7 rows
dated in the future — as far out as 2028 — and 2,902 dated before October 2025.
The old ones are legitimate (Form 5 and amendments report prior periods); a
future date is a typo. Ranking by recency without a guard puts a mistyped row at
the top, so the newest-date probe is clamped to today.

**The data lags by up to a quarter.** SEC republishes these quarterly, so the
most recent weeks are usually not in any release yet. The default window is
anchored to the newest data actually loaded rather than to today — otherwise
"the last 90 days" sits entirely past the edge of the data and returns nothing
for a question that has an answer. A window with no rows says which releases are
loaded rather than returning a bare empty list.

## Loading

```bash
node scripts/ingest-sec-insider.mjs 2026q2 2026q1
```

**The URL prefix moved.** The newest quarter is published under
`/files/datastandardsinnovation/data/…`; older ones remain under
`/files/structureddata/data/…`. Both are live — 2026q2 answers only on the first,
2026q1 only on the second — so a loader that knows one prefix silently cannot see
half the archive. Both are tried, newest layout first.

`FOOTNOTES.tsv` is the largest file in the zip (36.6 MB) and nothing here reads
it; it is not extracted. Schema: `supabase/migrations/072_sec_insider.sql`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec-insider": {
      "url": "https://gateway.pipeworx.io/sec-insider/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec-insider/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sec-insider": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sec-insider"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sec-insider
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec Insider data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
