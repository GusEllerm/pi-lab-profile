---
source: extensions/argo.ts
source-hash: 7809b6e5cefd978099ccdb938182df40b279777a
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
  `/v1` base). Both verified live with one request each. On the Anthropic path the usage carries
  `thinking_tokens` and cache fields, so thinking levels and cache accounting work through the proxy.
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
- **`argo:health {up}`** on the bus, from a 30 s `/health` poll while registered, so [[endpoints]]
  can flip the `ENDPOINT` row to `⚡ argo off` when `argo-down` closes the port.

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

## Verified

`tests/argo.test.mjs`: the rules, the config parser, the prompt detector, the relay round-tripping a
fake interactive child, and startup registration against a local stand-in serving `/health` and
`/v1/models` (and registering nothing when it is down). Live, 23 Sept 2026: `argo/claude-sonnet-4-6`
and `argo-openai/gpt-4o` each answered a one-token prompt through Pi. The Duo prompt path itself is
exercised by the fake child, not live — a real Duo needs a phone.

## Related

[[endpoints]] · [[statusbar]] · [[../00-start-here]]
