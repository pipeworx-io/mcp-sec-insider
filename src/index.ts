interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * SEC Forms 3/4/5 — insider transactions, indexed so the question can be
 * inverted.
 *
 * Every insider API is company-first, ours included: you pass an issuer and get
 * its Form 4s. "Which insiders bought the most last week, anywhere" has no filer
 * to start from — the aggregation is across all issuers at once — so no upstream
 * answers it. A flat, indexed table makes it a single query.
 *
 * THE TRANSACTION CODE IS THE WHOLE MEANING OF A ROW. In the loaded window,
 * 182,061 transactions break down as S 27,601 sales, A 19,211 grants, M 10,783
 * option exercises, F 9,357 shares withheld for tax — and only 11,261 P, an
 * open-market purchase. A "biggest buyers" ranking that counts A or M puts
 * people who bought nothing at the top: a grant is compensation and an exercise
 * is a conversion, neither is someone deciding to buy at market. Only P counts
 * as buying here, and the tool says so in its output.
 *
 * DATES HERE ARE FILER-SUPPLIED AND SOMETIMES WRONG. The covered
 * window contains 7 rows dated in the future (to 2028) and 2,902 dated before
 * October 2025. The old ones are legitimate — Form 5 and amendments report
 * prior-period transactions — but a future date is a typo, and ranking by
 * recency without a guard puts a mistyped 2028 row at the top of "most recent".
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'SEC Insider');
}


interface Cfg { url: string; key: string }

const TX = 'sec_insider_transactions';
const OWNERS = 'sec_insider_owners';
const SUBS = 'sec_insider_submissions';

/** Open-market purchase. The only code that means the insider chose to buy. */
const BUY_CODE = 'P';
/** Open-market or private sale. */
const SELL_CODE = 'S';

const CAVEAT =
  'Forms 3/4/5 are filed within two business days of a transaction and the SEC republishes them quarterly, so the data lags the market by up to a quarter. Only non-derivative open-market transactions are counted; option exercises (M), grants and awards (A) and shares withheld for tax (F) are excluded from buying and selling, because none of them is a decision to trade at market.';

async function pg<T>(cfg: Cfg, table: string, query: string): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`data query ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

function cfgFrom(args: Record<string, unknown>): Cfg {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('This tool must be called through the gateway that supplies its data connection.');
  return { url, key };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'insider_top_buyers',
    description:
      'Rank the biggest OPEN-MARKET insider purchases across every US public company at once — "which insiders bought the most stock recently", "who was buying their own company\'s shares". Returns the insider name and role, the issuer and ticker, shares, price per share and the dollar value, newest first. Counts only transaction code P, a purchase at market; option exercises, grants and tax withholding are excluded because none of them is a decision to buy. Sourced from SEC Forms 3/4/5.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Earliest transaction date, ISO (YYYY-MM-DD). Defaults to the last 90 days of the loaded window.' },
        until: { type: 'string', description: 'Latest transaction date, ISO (YYYY-MM-DD).' },
        min_value_usd: { type: 'number', description: 'Ignore purchases below this dollar value.' },
        limit: { type: 'number', description: 'How many to return (default 20, max 100).' },
      },
    },
  },
  {
    name: 'insider_top_sellers',
    description:
      'Rank the biggest OPEN-MARKET insider sales across every US public company at once — "which insiders sold the most stock recently". Returns insider name and role, issuer and ticker, shares, price and dollar value, newest first. Counts only transaction code S, a sale at market; shares withheld for tax (F) are excluded, since those are a payroll mechanism rather than a decision to sell. Sourced from SEC Forms 3/4/5.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Earliest transaction date, ISO (YYYY-MM-DD).' },
        until: { type: 'string', description: 'Latest transaction date, ISO (YYYY-MM-DD).' },
        min_value_usd: { type: 'number', description: 'Ignore sales below this dollar value.' },
        limit: { type: 'number', description: 'How many to return (default 20, max 100).' },
      },
    },
  },
  {
    name: 'insider_coverage',
    description:
      'Which SEC insider data is currently available: which quarterly releases are covered, how many filings, owners and transactions, and the date range of the transactions themselves. Call this to check how current the insider data is before relying on a ranking.',
    inputSchema: { type: 'object', properties: {} },
  },
];

interface TxRow {
  nonderiv_trans_sk: number;
  accession_number: string;
  security_title: string | null;
  trans_date: string | null;
  trans_code: string | null;
  trans_shares: number | null;
  trans_price_per_share: number | null;
  source_window: string | null;
}

/**
 * The newest transaction date the data can be trusted to hold.
 *
 * Filer typos put a handful of rows years in the future, so the raw max is not
 * the edge of the data — clamping to today keeps one mistyped row out of every
 * "most recent" answer.
 */
async function loadedWindow(cfg: Cfg): Promise<{ newest: string | null; oldest: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const [newest] = await pg<{ trans_date: string }[]>(
    cfg, TX, `select=trans_date&trans_date=lte.${today}&order=trans_date.desc&limit=1`,
  );
  const [oldest] = await pg<{ trans_date: string }[]>(
    cfg, TX, 'select=trans_date&order=trans_date.asc&limit=1',
  );
  return { newest: newest?.trans_date ?? null, oldest: oldest?.trans_date ?? null };
}

async function ranked(cfg: Cfg, args: Record<string, unknown>, code: string, label: 'purchase' | 'sale') {
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const minValue = Number(args.min_value_usd) || 0;
  const today = new Date().toISOString().slice(0, 10);
  const window = await loadedWindow(cfg);

  const until = typeof args.until === 'string' && args.until.trim() ? args.until.trim() : today;
  let since = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : null;
  if (!since) {
    // Default to the 90 days ending at the newest data we actually hold, not the
    // 90 days ending today — otherwise the default window sits entirely after
    // the data's edge and returns nothing for a question that has an answer.
    const anchor = window.newest ? new Date(window.newest) : new Date();
    anchor.setDate(anchor.getDate() - 90);
    since = anchor.toISOString().slice(0, 10);
  }

  // Over-fetch: value is shares x price and PostgREST cannot order on a computed
  // product, so the ranking is done here over a bounded slice.
  const rows = await pg<TxRow[]>(
    cfg, TX,
    `select=nonderiv_trans_sk,accession_number,security_title,trans_date,trans_code,trans_shares,trans_price_per_share,source_window`
    + `&trans_code=eq.${code}&trans_date=gte.${since}&trans_date=lte.${until}`
    + '&trans_shares=not.is.null&trans_price_per_share=gt.0'
    + '&order=trans_date.desc&limit=4000',
  );

  const priced = rows
    .map((r) => ({ ...r, value_usd: (r.trans_shares ?? 0) * (r.trans_price_per_share ?? 0) }))
    .filter((r) => r.value_usd >= minValue)
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, limit);

  if (!priced.length) {
    return {
      found: false,
      reason: 'no_transactions_in_window',
      requested_window: { since, until },
      // The window the caller asked about may simply be after the newest release
      // — saying which quarter the coverage ends at is what stops them re-asking.
      loaded_window: window,
      message: `No open-market ${label}s in ${since} to ${until}. Coverage runs from ${window.oldest ?? '?'} to ${window.newest ?? '?'}; the SEC republishes these quarterly, so the most recent weeks are typically not yet in a release.`,
      caveat: CAVEAT,
    };
  }

  const accessions = [...new Set(priced.map((r) => r.accession_number))];
  const inList = `(${accessions.map((a) => `"${a}"`).join(',')})`;
  const [issuers, owners] = await Promise.all([
    pg<{ accession_number: string; issuer_name: string | null; issuer_symbol: string | null }[]>(
      cfg, SUBS, `select=accession_number,issuer_name,issuer_symbol&accession_number=in.${inList}`,
    ),
    pg<{ accession_number: string; owner_name: string | null; officer_title: string | null; is_director: string | null; is_officer: string | null; is_ten_pct_owner: string | null }[]>(
      cfg, OWNERS, `select=accession_number,owner_name,officer_title,is_director,is_officer,is_ten_pct_owner&accession_number=in.${inList}`,
    ),
  ]);
  const issuerBy = new Map(issuers.map((i) => [i.accession_number, i]));
  const ownerBy = new Map<string, typeof owners[number]>();
  for (const o of owners) if (!ownerBy.has(o.accession_number)) ownerBy.set(o.accession_number, o);

  const role = (o?: typeof owners[number]) => {
    if (!o) return null;
    const parts: string[] = [];
    if (o.is_officer === 'Y') parts.push(o.officer_title || 'Officer');
    if (o.is_director === 'Y') parts.push('Director');
    if (o.is_ten_pct_owner === 'Y') parts.push('10% owner');
    return parts.length ? parts.join(', ') : null;
  };

  return {
    found: true,
    transaction_type: label === 'purchase' ? 'open-market purchase (code P)' : 'open-market sale (code S)',
    window: { since, until },
    loaded_window: window,
    count: priced.length,
    [label === 'purchase' ? 'purchases' : 'sales']: priced.map((r) => {
      const iss = issuerBy.get(r.accession_number);
      const own = ownerBy.get(r.accession_number);
      return {
        insider: own?.owner_name ?? null,
        role: role(own),
        issuer: iss?.issuer_name ?? null,
        ticker: iss?.issuer_symbol ?? null,
        security: r.security_title,
        trans_date: r.trans_date,
        shares: r.trans_shares,
        price_per_share: r.trans_price_per_share,
        value_usd: Math.round(r.value_usd),
        accession_number: r.accession_number,
        release: r.source_window,
      };
    }),
    caveat: CAVEAT,
  };
}

/**
 * Which quarterly releases are actually loaded.
 *
 * Reading a page of rows and de-duplicating does NOT work here: PostgREST has no
 * DISTINCT, and the first 2,000 submissions ordered by release are all from the
 * newest one, so a two-quarter range reported a single quarter. The bounds are
 * cheap to read, and the quarters between them are enumerable — so each
 * candidate is probed for a single row instead of guessed at from a page.
 */
async function loadedReleases(cfg: Cfg): Promise<string[]> {
  // source_feed=quarterly only. The daily feed reaches into the quarter AFTER
  // the newest release, and counting it here would advertise a consolidated SEC
  // dataset we do not hold for that quarter.
  const [first] = await pg<{ source_window: string }[]>(cfg, SUBS, 'select=source_window&source_feed=eq.quarterly&order=source_window.asc&limit=1');
  const [last] = await pg<{ source_window: string }[]>(cfg, SUBS, 'select=source_window&source_feed=eq.quarterly&order=source_window.desc&limit=1');
  if (!first?.source_window || !last?.source_window) return [];
  const parse = (w: string) => { const m = w.match(/^(\d{4})q([1-4])$/); return m ? { y: Number(m[1]), q: Number(m[2]) } : null; };
  const a = parse(first.source_window);
  const b = parse(last.source_window);
  if (!a || !b) return [...new Set([first.source_window, last.source_window])];
  const candidates: string[] = [];
  for (let y = a.y, q = a.q; y < b.y || (y === b.y && q <= b.q); q === 4 ? (q = 1, y += 1) : (q += 1)) {
    candidates.push(`${y}q${q}`);
  }
  const present = await Promise.all(candidates.map(async (w) => {
    const rows = await pg<unknown[]>(cfg, SUBS, `select=source_window&source_window=eq.${w}&source_feed=eq.quarterly&limit=1`);
    return rows.length ? w : null;
  }));
  return present.filter((w): w is string => w !== null);
}

/**
 * The daily feed's extent, kept separate from the quarterly releases.
 *
 * The SEC publishes these datasets QUARTERLY, so there is always a gap between
 * the newest release and today — six weeks to a full quarter, and precisely
 * where "who was buying last week" is aimed. scripts/ingest-sec-insider-daily.mjs
 * fills it from EDGAR's daily index, and those rows carry source_feed='daily'.
 *
 * A caller has to be able to tell the two apart. They differ in kind, not just
 * in age: a quarterly release is the SEC's own consolidated dataset, while the
 * daily rows are parsed from individual Form 4 documents as they are filed, and
 * are replaced by the release once it appears.
 */
async function dailyWindow(cfg: Cfg) {
  // Same clamp as loadedWindow() above, and for the same reason: a filer typo
  // can land a trans_date years in the future (hit live 2026-09-04 — a Form 4
  // filed 2026-09-03 carried transactionDate 2027-09-03 verbatim in the
  // filer's own XML), and an unclamped MAX() reports that as "how fresh is
  // the daily feed" — which is exactly backwards, since the ingest that day
  // was current, not stale-and-then-wrong. Only the newest bound needs
  // clamping; a bogus OLD date understates freshness rather than fabricating
  // it, which is the safer direction to leave unguarded.
  const today = new Date().toISOString().slice(0, 10);
  const [newest] = await pg<{ trans_date: string }[]>(
    cfg, TX, `select=trans_date&source_feed=eq.daily&trans_date=lte.${today}&order=trans_date.desc&limit=1`);
  const [oldest] = await pg<{ trans_date: string }[]>(
    cfg, TX, 'select=trans_date&source_feed=eq.daily&order=trans_date.asc&limit=1');
  if (!newest?.trans_date || !oldest?.trans_date) return null;
  return { oldest: oldest.trans_date, newest: newest.trans_date };
}

async function coverage(cfg: Cfg) {
  const window = await loadedWindow(cfg);
  const [loaded, daily] = await Promise.all([loadedReleases(cfg), dailyWindow(cfg)]);
  // loadedReleases now counts quarterly rows only, so this is already the list
  // of real SEC releases — a quarter present solely via the daily feed is
  // reported under daily_feed instead.
  const quarterly = loaded;
  return {
    source: 'SEC Forms 3/4/5 — quarterly archives, extended to the present by the EDGAR daily index',
    releases_loaded: quarterly,
    latest_release: quarterly[quarterly.length - 1] ?? null,
    daily_feed: daily
      ? {
          transaction_date_range: daily,
          what_it_is: 'Form 4 documents parsed from the EDGAR daily index, covering the weeks after the newest quarterly release.',
          replaced_when: 'The quarterly release for a period supersedes these rows; the ingest drops them when it appears, so the two never double-count.',
        }
      : null,
    recent_edge: daily
      ? `Quarterly releases end at the close of ${quarterly[quarterly.length - 1] ?? 'the newest release'}; everything after that up to ${daily.newest} comes from the daily feed.`
      : 'No daily feed loaded — coverage ends at the newest quarterly release, which is typically six weeks to a quarter behind today.',
    transaction_date_range: window,
    counted_as_buying: 'transaction code P only (open-market purchase)',
    excluded_from_buying: ['M — option or derivative exercise', 'A — grant, award or other acquisition', 'F — shares withheld for tax'],
    caveat: CAVEAT,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const cfg = cfgFrom(args);
  switch (name) {
    case 'insider_top_buyers':
      return ranked(cfg, args, BUY_CODE, 'purchase');
    case 'insider_top_sellers':
      return ranked(cfg, args, SELL_CODE, 'sale');
    case 'insider_coverage':
      return coverage(cfg);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
