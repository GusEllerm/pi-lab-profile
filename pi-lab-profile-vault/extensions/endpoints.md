---
source: extensions/endpoints.ts
source-hash: 9e3ec792fb1b20ba6af653d67d8df9f10c6394e1
documented: 2026-09-20
---

# endpoints.ts — names the inference endpoint behind the active model, and probes the clusters live

## What it owns

Two things, both about *where inference actually goes*:

1. **The endpoint status.** A footer/sidebar slot and Pi's native `endpoint` status key showing a
   short name for the endpoint the current model hits, with a ✓/✗ mark taken from the last assistant
   reply. It follows every model change — `/model`, Ctrl+P, session restore.
2. **`/endpoints`.** A live probe of every provider declared in `models.json`, listing each model as
   up / down / live / queued / cold, including models the cluster offers that `models.json` does not
   declare. Enter on a configured model switches to it.

It also owns the **canonical short label per provider** (`statusbar:endpoint-labels`), which
[[statusbar]] reuses so the sidebar, menus and cards all name an endpoint the same way.

It owns no configuration of its own: providers come from `models.json`, and adding one there is
enough for it to appear here.

## Commands

| Command | What it does |
|---|---|
| `/endpoints` | Opens a tree at once — one folder per provider (`models.json` plus the two Argo providers registered at runtime), each summarised on the right (`1 live · 2 cold`, `probing…` until its probe lands) — and probes every provider in parallel, filling folders in as results arrive. → / ← / enter / space open and close a folder; an open one shows its `baseUrl` and a row per model with live state and an `◀ active` marker. Enter on a configured model calls `pi.setModel`; on an offered-but-unconfigured model it notifies where to add it. |

## Configuration

**Where providers come from.** `MODELS_JSON` is `$PI_CODING_AGENT_DIR/models.json`, falling back to
`~/.pi/agent/models.json`. `customProviderIds()` reads the top-level `providers` keys; only models
whose `provider` is in that set are listed, so Pi's built-in hosted providers are skipped. A provider
entry supplies `name` (the display label), `baseUrl`, `api`, `apiKey` and `compat`. `endpointLabel`
prefers the registry's display name and falls back to `provider · host`.

`profiles/lab/models.json` declares four: `globus` (one vLLM model behind an SSH tunnel) and
`alcf-minerva`, `alcf-metis`, `alcf-sophia` (the ALCF gateway). The ALCF three use
`"apiKey": "!~/.local/bin/alcf-token"` — a `!`-prefixed command the model registry runs; this file
never reads it directly, it asks `ctx.modelRegistry.getApiKeyForProvider(provider)`.

**Which probe runs is decided by host, not by provider name.** If
`hostOf(models[0].baseUrl) === "inference-api.alcf.anl.gov"` it is `probeAlcf`, otherwise
`probeGlobus`. Every model of a provider is assumed to share `models[0].baseUrl`.

**globus — and the tunnel requirement.** The lab's endpoint is deliberately not exposed publicly;
it is reached by an SSH port-forward to `globus1`, so its `baseUrl` is `http://127.0.0.1:8000/v1`
and no auth is sent. The probe is one unauthenticated `GET {baseUrl}/models`; models the endpoint
serves are `● up`, declared models it does not serve are `○ absent`, and served models missing from
`models.json` are appended as `(served, not in models.json)`. **With the tunnel down every row reads
`? down`** — a `fetch failed`/`ECONNREFUSED` is translated into the actionable hint
`tunnel down — run: globus-tunnel ensure` rather than the raw error.

**ALCF.** The `baseUrl` is parsed *positionally*: the gateway is everything up to and including
`/resource_server/`, and the remainder splits as `<cluster>/<framework>/…`. The probe then does two
authenticated GETs — `{gateway}list-endpoints` (what the clusters offer) and `{gateway}{cluster}/jobs`
(what is running or queued right now) — via `Promise.allSettled`, so one failing degrades the rows
instead of the section. `list-endpoints` is memoized for 5 s so one `/endpoints` run fetches it once
for all ALCF providers. State per model: `● live` / `◌ queued` from the jobs payload, `○ cold` when
the jobs call succeeded and the model is in neither list (the first request asks the scheduler to
start it — expect a wait or a 503), and `? listed` / `? unknown` when the jobs call failed. With no
token, every row is `? no auth` annotated with the contents of
`$XDG_CACHE_HOME/alcf-token/last-error` (default `~/.cache/alcf-token/last-error`).

**Curation of the offered list.** `NON_CHAT` filters embeddings, genomics encoders and segmentation
services out of what the gateway offers. `EXCLUDED`, keyed `<cluster>/<modelId>`, records models that
were tried against Pi's tool loop on 2026-09-17 and deliberately left out of `models.json`; those rows
still appear, annotated with *why* they were excluded. Both are per-repo knowledge, not config.

Per-fetch timeout is `PROBE_TIMEOUT_MS` (8 s) via `AbortSignal.timeout`.

## Events consumed and emitted

| Event | Direction | Payload | Why |
|---|---|---|---|
| `statusbar:slot` | emitted | `{ id: "endpoint", text: shortName, state: "ok" \| "error" \| "plain", statusKey: "endpoint", details: () => string[] }` | The endpoint cell in the column; `details()` gives the full label and `baseUrl` to the dashboard |
| `statusbar:endpoint-labels` | emitted | `{ [provider]: shortLabel }` | One short name per provider so every other surface agrees; statusbar falls back to the registry display name for providers not covered |
| `statusbar:ready` | consumed | — | The bar re-emits at session start; republish both of the above regardless of load order |
| `argo:health` | consumed | `{ up, port, models }` | From [[argo]]: flips the ENDPOINT row to `⚡ argo down`, and supplies the registered-model count for the Argo probe's `55 ids · 38 models` |
| `session_start` | consumed (`pi.on`) | `ctx` | Cache `ctxRef`, set the native status, publish slot and labels |
| `model_select` | consumed (`pi.on`) | `{ model }` | Re-label and reset `lastReply` to `"plain"` — the new endpoint has not answered yet |
| `message_end` | consumed (`pi.on`) | `{ message }` | Assistant messages only: an `errorMessage` or `stopReason === "error"` flips the slot to ✗, anything else to ✓ |

## Modules

**Provider reading and labelling — `MODELS_JSON`, `customProviderIds`, `hostOf`, `endpointLabel`.**
All tolerant: an unreadable or malformed `models.json` yields an empty provider list and `/endpoints`
notifies instead of throwing; an unparseable URL returns itself from `hostOf`.

**Status publication — `ctxRef`, `lastReply`, `shortName`, `publishTab`, `publishLabels`,
`setEndpointStatus`.** `shortName` is where the naming convention lives: ALCF hosts become
`ALCF <Cluster>` from the path segment, `globus` becomes `globus3`, anything else takes the first
segment of the registry display name before ` · `. `ctxRef` is the module's handle on the session and
is refreshed on `session_start` and `model_select`; everything that publishes bails out if it is
unset.

**ALCF payload parsing — `alcfOffered`, `alcfJobStates`, `listEndpoints`, `EXCLUDED`, `NON_CHAT`,
`lastTokenError`.** `alcfOffered` digs `clusters[cluster].frameworks[framework].models` out of the
`list-endpoints` payload; `alcfJobStates` flattens the `running`/`queued` job lists, whose `Models`
field is a comma-separated string, into a per-model map. Non-obvious: **`framework` is whatever path
segment follows the cluster**, and the lab's Minerva and Metis URLs are `…/<cluster>/api/v1`, so
their framework reads as `api` and `alcfOffered` finds nothing under it. Those clusters therefore
never show "offered, not in models.json" rows — their live/queued/cold state still works, because
that comes from `jobs`. Only Sophia (`…/sophia/vllm/v1`) matches a real framework key.

**Probes — `getJson`, `probeGlobus`, `probeAlcf`.** Each returns `Row[]`; a `Row` carries an optional
`model` (selectable) or an optional `note` (an id that exists on the cluster but is not configured).

**The tree — `Section`, `TreeRow`, `summarize`, `treeRows`, `EndpointTree`, the `/endpoints`
handler (23 Sept 2026; replaced a flat `ctx.ui.select` list).** One folder per machine. The
handler builds a `Section` per provider (label, `baseUrl`, `rows` undefined until its probe
lands), opens the dialog **immediately** through `ctx.ui.custom`, and lets each probe fill in its
section and call `tree.refresh()` + `tui.requestRender()` as it resolves — so the title reads
`probing 3…` and counts down. `treeRows(sections, open)` is the pure row model: a `folder` row per
section and, when open, a dim `url` row and one `model` row per probe `Row`. `summarize(rows)` is
the closed folder's right-hand text — `1 live · 2 cold` — read back from each label's leading
`<glyph> <state>` token (two spaces before the id, which is why every probe label is shaped that
way); `probing…` before the probe lands, `nothing served` on an empty result, `N notes` when only
glyph-less lines came back. Keys: ↑↓ skip `url` rows; → opens, ← closes (from a model row, closes
its folder and lands on the folder line); enter or space toggles a folder; enter on a model
returns its `Row`, and the handler switches with `pi.setModel` as before. `openFolders` is
module-level so the view is where you left it within a session; the active model's folder is
always opened on entry. Tested in `tests/endpoints-tree.test.mjs` (row model and summary); the
component is driven live by a harness.

### 22 Sept 2026 review fixes

- The ALCF framework was read positionally from the URL (`…/<cluster>/<framework>/v1`), which is a
  real framework name for Sophia (`vllm`) and the literal `api` for Minerva and Metis — so
  `alcfOffered` found nothing for two of the three clusters and a failed `jobs` call degraded to
  `? unknown` instead of `? listed`. When the segment names no framework the gateway lists, every
  framework the cluster offers is pooled (M11).
- `getJson` keeps undici's real reason from `error.cause` (`ECONNREFUSED`, `ENOTFOUND`, a cert
  error) and reports a timeout as `no answer in 8s`; the tunnel hint matches those too (M12).
- `listEndpointsMemo` no longer caches a rejected promise for five seconds, and is keyed by
  gateway. A base URL without `/resource_server/` now yields an explicit `? unknown … (unrecognised
  ALCF URL)` row instead of probing the first sixteen characters of the URL as a gateway.

**Corrections to the gotchas above.** `keys()`'s try/catch covers one `emit`, not the post-probe
code: everything after the ~8 s `await` in the `/endpoints` handler touches `ctx` unguarded, and is
survivable only because the host catches a throw inside a *slash-command handler*. A new async path
outside a command handler would not be. And a URL that lost `/resource_server/` never routed to
`probeGlobus` — only a host change does that; it now gets the explicit unknown row.

### Argo (23 Sept 2026)

Providers named `argo`/`argo-openai` get their own probe (`probeArgo`: `/health`, then the catalogue
size, printed as `55 ids · 38 models · metered` — catalogue entries, then the count [[argo]] reports
on `argo:health` after folding aliases — never opens anything) and a deliberate badge: `shortName` is `⚡ argo`, the slot state is at
least `warn` while up and `error` when [[argo]] reports the tunnel down over `argo:health`. The
details row says why: metered, and prompts leave through a proxy that may log them.

## Invariants a future change must not break

1. **The dialog opens before the probes finish.** Probing four clusters takes ~10 s; with no
   dialog on screen a ↓ pressed while waiting silently focused [[fleet]]'s agent list, which is why
   this file used to bracket the probe with `fleet:keys-hold` / `keys-release`. The tree replaces
   that: it is up at once and owns the keyboard, and probes fill it in. Do not reintroduce an
   `await` between the command and the dialog. (fleet still honours the hold events for others.)
2. **Late probe results must not assume the dialog is still there.** `render()` wraps
   `tui.requestRender()` in a try and is set to `undefined` once the dialog closes; a `/reload`
   during a probe reaches the `.then` with nothing to draw into and must never throw.
3. **Every probe label is `<glyph> <state>  <id>…` with two spaces before the id.** `summarize()`
   reads the state back from that shape; a single space turns `? no auth  id` into a state called
   "no auth id" and the folder summary goes wrong.
4. **`shortName` output is a shared vocabulary**, cached by statusbar and used in its sidebar and
   dashboard. Renaming an endpoint here renames it everywhere — which is the point; doing it
   *inconsistently* is the bug.
5. **A provider's models are assumed to share `models[0].baseUrl`**, for both probe selection and the
   gateway/cluster parse. Mixing base URLs under one provider id silently probes the wrong thing.
6. `row.model` ⇒ switch; `row.note` alone ⇒ notify. A row with neither is a note (a failed
   sub-probe, an excluded model) and Enter on it does nothing.

## Gotchas

- **There is no `dead` flag here.** Unlike [[rounds]], this file registers no `session_shutdown`
  handler and its `publishTab`/`publishLabels` emit on `pi.events` directly. That is safe only
  because they run from live event handlers, never from a timer or a promise continuation — the one
  exception is the `finally` after the ~10 s probe, which is exactly what the `try`/`catch` inside
  `keys()` covers. Any new async path that emits after an await needs its own guard; do not assume
  the rounds-style protection is already here.
- `listEndpointsMemo` is keyed only by time, not by gateway or headers. Fine while every ALCF
  provider shares one gateway; a second gateway added within the 5 s window would be served the first
  one's payload.
- `? cold` is only distinguishable from `? unknown` when the `jobs` call succeeded. A gateway that
  answers `list-endpoints` but not `jobs` makes every model read `? listed`.
- `ALCF_HOST` and the `/resource_server/` marker are hardcoded; an ALCF URL scheme change silently
  routes those providers to `probeGlobus`, which will report them all as down.
- `message_end` only tracks the **main session's** assistant messages, so the ✓/✗ says nothing about
  the endpoints subagents are using.
- `pi.setModel` is given `ctx.modelRegistry.find(...)` with the raw row model as a last-resort
  fallback; a provider with no resolvable credentials fails there and only then notifies.
- The probe is fired on every `/endpoints` invocation with no caching beyond the 5 s
  `list-endpoints` memo — repeated invocations hit the shared cluster gateway each time.

## Related

- [[rounds]] — `rounds.json` names models by `provider/modelId`; this is how you check they are up
- [[statusbar]] — consumes `statusbar:slot` and `statusbar:endpoint-labels`
- [[fleet]] — owns the `fleet:keys-hold` / `fleet:keys-release` counter
- [[../architecture/pi-internals]] — `modelRegistry`, `getApiKeyForProvider`, `!command` apiKeys
- `docs/setup-guide.md` (repo, not vault) — the `globus-tunnel` helper this probe depends on, and the
  ALCF gateway setup behind `~/.local/bin/alcf-token`
