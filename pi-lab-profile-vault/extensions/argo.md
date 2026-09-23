---
source: extensions/argo.ts
source-hash: d6d537349964a9994764a588d57b18dc443d5990
documented: 2026-09-23
---

# argo.ts — Argo's frontier models as Pi providers, tunnel kept in the user's hands

Argonne's Argo gateway, reached through the user's own [argo-tools](https://github.com/GusEllerm/argo-tools):
`argo-proxy` on a CELS home node, an SSH tunnel through the Duo bastion, `localhost:44497` speaking
both the OpenAI and Anthropic APIs, authenticating by ANL username. Built 23 Sept 2026 after the
decisions in the session: no `/round` use (metered), `/argo on`/`down` in-session with the Duo
prompt relayed, de-duplicated real models, a privacy badge.

## What it owns

- **Two providers**, because the two APIs disagree about `baseUrl`: `argo` (Claude, `anthropic-messages`,
  bare host — clients append `/v1/messages`) and `argo-openai` (GPT/Gemini, `openai-completions`,
  `/v1` base). Both verified live with one request each. Thinking levels work through the proxy.
- **Spend, priced as argo-dash prices it.** `loadPricing` imports the installed `argo-dash` in a
  python subprocess (`PRICING_DUMP`, ~50 ms) and takes its `PRICING`/`PROMOS`/`CACHE_MULTIPLIER`
  table; `BUNDLED_PRICING` is the fallback, a copy dated by `verified`. `ratesFor` applies the
  dash's `canon_model` rules and promo expiry; Claude `modelDef`s carry the result as Pi `cost`, so
  Pi's own `calculateCost` produces the dash's "list $". Other families stay unpriced, as on the
  dash. `sessionSpend` sums the branch; `/argo` prints it; **`/argo spend`** runs `argo-dash --once`
  (proxy log, exact) or `--totals` (local ledger) and pages the report through [[outputs]]' `Pager`.
- **The zeroed prompt count.** Measured 23 Sept 2026: argo-proxy's *streamed* `message_start`
  carries `input_tokens: 0` and no cache fields (the non-streaming reply has them all), and Pi
  streams. Pi's `calculateContextTokens` is `totalTokens || input+output+cacheRead+cacheWrite`, so
  an Argo Claude turn registered as a few output tokens: the CONTEXT row read 0.0%, the trajectory
  misfired, and auto-compaction could never trigger. The `message_end` hook (Pi lets a handler
  replace a finalised message) calls `repairUsage`: when input+cacheRead+cacheWrite is 0 it puts
  `estimateTokens` (Pi's chars/4, 4800 chars per image, over the prior branch plus the system
  prompt) in `input`, prices it at the input rate, and sets `usage.estimated = true`, which
  [[statusbar]] shows as `≈` and `est.`. Anything the proxy did report is left untouched; the
  `argo-openai` path reports usage in full (checked with `stream_options.include_usage`).
- **The catalogue rules** (`canonical`, `dedupe`, `order`, `modelDef`): `argo:` stripped, Claude dots
  to dashes and the reversed alias folded (`claude-4.8-opus` ≡ `claude-opus-4.8` — Argo lists ten
  models twice), `[test]`/embedding/reranker dropped, `PREFERRED` frontier-first ordering. Identical
  to `argo-claude`'s so the two tools name a model the same way. Conservative metadata per family;
  unknown ids still register.
- **`/argo on`** runs `argo-up` inside a pseudo-terminal (`PTY_RELAY`, Python's `pty`, embedded — no new
  dependency), relays its lines into the chat, and turns a prompt (`looksLikePrompt`: an unterminated
  line asking for a passcode/option/password) into `ctx.ui.input`. The answer goes to the child's
  pty. The relay exits when `argo-up` does, not when the pty closes — `ssh -f` leaves a master
  holding it open on purpose. **`/argo down`** runs `argo-down` and unregisters. **`/argo reload`**
  re-reads the catalogue. Startup registers only if `/health` already answers.
- **`argo:health {up, port, models}`** on the bus, from a 30 s `/health` poll while registered, so
  [[endpoints]] can flip the `ENDPOINT` row to `⚡ argo off` when `argo-down` closes the port, and
  print `55 ids · 38 models` (catalogue entries, then what survives alias folding) in `/endpoints`.

## Why it is shaped this way

- **Never opens the tunnel on its own.** `argo-down`'s guarantee — nothing on this machine reaches
  Argo until you act — is the user's security posture, and an extension quietly re-opening it would
  undo it. `/argo on` is the user acting.
- **ssh reads Duo from the controlling terminal**, not stdin, and Pi owns the terminal. Hence the pty.
- **Metered and logged upstream**, hence the badge and no `/round` default.

## Invariants a future change must not break

- Every fetch has a timeout; the poll runs only while registered and is cleared on shutdown; the
  child is killed on shutdown; every notify after an await is behind `dead`.
- The catalogue rules must stay identical to `argo-claude`'s, or the same model gets two names.
- `repairUsage` never overwrites a reported count. If argo-proxy starts streaming real usage, the
  hook goes quiet on its own; do not make it unconditional.
- Prices come from argo-dash first. Do not edit `BUNDLED_PRICING` without re-verifying the dash's
  table; the dash is where rates are checked against Anthropic's page.

## Verified

`tests/argo.test.mjs` (15): the rules, the config parser, the prompt detector, the relay
round-tripping a fake interactive child, startup registration against a local stand-in serving
`/health` and `/v1/models` (and registering nothing when it is down), the rate rules and promo
dates, `parsePricing` rejecting half-formed dumps, `loadPricing` against a fake `argo-dash` script
(and falling back when it is broken or absent), the token estimate, `repairUsage`, `sessionSpend`,
and the `message_end` hook through a fake `pi`. Live, 23 Sept 2026: `argo/claude-sonnet-4-6` and
`argo-openai/gpt-4o` each answered a one-token prompt through Pi; after one Argo turn the column
read `CONTEXT 1.3%`, `USAGE in ≈2.6k · out 4 · ≈ $0.0078 est.`, `/argo` printed the session
line, `/argo spend` paged `argo-dash --once` (375 sonnet requests, $23.76), and `/endpoints`
showed `55 ids · 38 models · metered`. The Duo prompt path itself is exercised by the fake child,
not live — a real Duo needs a phone.

## Upstream

- **argo-proxy** zeroes usage in the streamed `message_start`. The exact fix is theirs; ours is the
  estimate above. Worth filing with a curl transcript (non-streaming vs `"stream": true`).
- **argo-dash** takes the output half of its join from Claude Code transcripts only, so Pi-made
  requests show `?` in its output column. Pi records the upstream id as `responseId` on each
  assistant message in `~/.pi/agent/sessions/*/*.jsonl`, so the dash could join those too — a
  small change in the user's own repo, offered, not made.

## Related

[[endpoints]] · [[statusbar]] · [[outputs]] · [[../00-start-here]]
