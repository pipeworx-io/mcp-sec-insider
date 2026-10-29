# sec-insider

SEC **Forms 3/4/5** — insider transactions, hosted so the question can be inverted.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this is hosted

Every insider API is company-first, ours included: you pass an issuer and get its
Form 4s. *"Which insiders bought the most last week, anywhere"* has no filer to
start from — the aggregation is across all issuers at once — so no upstream can
answer it. A flat table makes it one indexed query.

## Tools

- `insider_top_buyers({since?, until?, min_value_usd?, limit?, group_by?, issuer?, owner?, exclude_funds?, include_suspect?})` —
  biggest open-market purchases across every issuer, by dollar value, ranked
  over EVERY row in the window (never a capped slice — fleet #3354).
  `group_by` controls the roll-up before ranking: `"filing"` (default) sums a
  Form 4's price-band lines into one total (a report filed as several
  documents for the same issuer, reporting owners and period of report, whose
  parts start on the same trade date, counts as one filing), `"row"` keeps
  each line separate,
  `"owner"` sums every filing by the same insider against the same issuer
  across the window. `issuer`/`owner` narrow to one pair (ticker/CIK or a
  name substring), e.g. "how much Lennar did Berkshire buy in September".
- `insider_top_sellers({…})` — the same for sales.
- `insider_coverage()` — which quarterly releases are loaded and what counts as
  buying. Check this before trusting a ranking.

## Ranking is over the whole window, never a capped slice (fleet #3354)

This used to fetch `order=trans_date.desc&limit=4000` and sort by value in JS —
but PostgREST caps every response at 1,000 rows regardless of the limit asked
for, so a full month's P-code rows across every issuer never made it past the
newest ~1,000 before the cut, so rows dated early in the month were never
fetched at all. The fix pages the whole
window with `pgReadAll` and ranks/groups over everything it returns;
`rows_considered` and `rows_truncated` are in every response so a cut can
never be silent again.

**Price sanity (fleet #3397).** A transaction priced more than 10x or under
0.1x the same issuer's own price, for the same class of security, is treated as
a probable filer error and excluded from rankings by default; pass
`include_suspect: true` to see it, with `suspect: true` and a `suspect_reason`.
The reference comes from the issuer's own trades, in this order:

1. other filings the same ISO week (two or more trades);
2. other filings within 180 days, including trades outside the requested
   window, judged against the nearest five trades before and after. A row
   that agrees with either side, or with the single nearest trade on a side,
   is not flagged. That is how a reverse split (CytoSorbents, September 2026:
   ~$0.40 before, ~$6 after) passes and a typo does not;
3. the other lines on the same filing (two or more);
4. otherwise unassessed, never flagged.

The test is relative, never a dollar cap: NVR, AutoZone or Berkshire Class A
are not flagged for trading above $1,000. Class A and Class B, common and
preferred, and ADSs and the shares they bundle are never compared with each
other. Every response carries `price_check.basis_counts`, so "not flagged" and
"never checked" can be told apart. Over every September 2026 purchase, it flags
two rows: UUU's 18,000 shares at $5,134 (the stock trades near $5) and a $614
line on a Lucky Strike filing (near $6).

**Filing totals match EDGAR.** Every accession behind the top September
filings (Berkshire/Buffett→Lennar, Cascade/Gates→Republic Services, Baker
Bros→Kodiak) sums to the dollar against the filing's own non-derivative table
(code P, shares x price). Joint reporting owners do not double a total: the
transaction rows belong to the filing, not to each owner. Berkshire's three
September filings total $402.7M; its fourth filing in that series reports
1-2 October trades, so a September window holds three. Baker Bros' ~$157.0M
is one report filed as three documents, counted as one filing; it ranks fourth
for September behind Berkshire's $212.4M and Cascade's $164.7M and $159.6M.
A trade filed twice, as two accessions with the identical date, security,
shares, price and shares-owned-after for the same issuer and owners, is counted
once (`duplicate_rows_excluded`); in September 2026 that was 11 rows, ~$1.9M.

**Prices are not always in dollars (fleet #3353).** Form 4 has no currency
field; a filer pricing abroad says so in a footnote on the price. Banco
Bradesco's Form 4s price BBDC4 lots at about 17 with the footnote "Brazilian
reais" — about 5x overstated if read as US dollars. The loaders store the
price's own footnote and derive `price_currency` from it. A row whose stated
currency is not USD, or whose footnote names two currencies without saying
which, is left out of the US-dollar rankings and counted in
`non_usd_rows_excluded` (with `non_usd_examples`); it is not converted. Many
Brazilian filers convert to dollars themselves and say so ("translated into
U.S. dollars at the selling rate") — those stay in as USD.
`currency_unassessed_rows` counts ranked rows loaded before footnotes were
read, which are treated as US dollars.

**Funds aren't insiders.** Some issuers are funds whose large unitholders
report under Section 16 the same way a company's officers do (e.g. AMG
Pantheon Infrastructure Fund) — buying fund units isn't an insider deciding
to buy a company's stock. `exclude_funds: true` drops these on request
(best-effort name/security-type heuristic); off by default.

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

**SEC's own quarterly archive lags, but a daily feed closes most of the gap.**
The consolidated quarterly release is several weeks behind, but
`scripts/ingest-sec-insider-daily.mjs` extends coverage to near-real-time from
the EDGAR daily index (call `insider_coverage` for the exact freshness) — so
most transactions are available within days, not a quarter. The default
window is anchored to the newest data actually loaded rather than to today —
otherwise "the last 90 days" sits entirely past the edge of the data and
returns nothing for a question that has an answer. A window with no rows says
which releases are loaded rather than returning a bare empty list.

## Loading

```bash
node scripts/ingest-sec-insider.mjs 2026q2 2026q1
```

**The URL prefix moved.** The newest quarter is published under
`/files/datastandardsinnovation/data/…`; older ones remain under
`/files/structureddata/data/…`. Both are live — 2026q2 answers only on the first,
2026q1 only on the second — so a loader that knows one prefix silently cannot see
half the archive. Both are tried, newest layout first.

The footnotes file is read for the footnotes attached to each transaction's
price, which set `price_footnote`, `price_currency` and `price_currency_basis`.
Rows loaded earlier are re-tagged by reloading the quarter, or, for the daily
feed, with `node scripts/ingest-sec-insider-daily.mjs --retag-currency --since <date>`.
Schema: `supabase/migrations/072_sec_insider.sql`, `266_sec_insider_price_currency.sql`.

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

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/insider_top_buyers \
  -H 'Content-Type: application/json' \
  -d '{"limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/insider_top_buyers`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-sec-insider` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/sec-insider/mcp` endpoint shown above. It needs network access;
there is no offline mode.

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

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

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
