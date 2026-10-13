# Argo: frontier models, metered

[Argo](https://www.anl.gov) is Argonne's gateway to Claude, GPT and Gemini, reachable only from
inside the lab's network. [argo-tools](https://github.com/GusEllerm/argo-tools) runs `argo-proxy`
on a CELS home node and forwards it to `localhost:44497` through an SSH tunnel with Duo; with
that set up, the harness registers what Argo serves as two Pi providers:

- `argo/<claude-…>` over the Anthropic messages API, with thinking levels
- `argo-openai/<gpt-…|gemini-…>` over chat completions

The catalogue is read live, aliases are folded (`claude-5-opus` and `claude-opus-5` are one
model), test, embedding and reranker models are dropped, and the frontier models come first in
`/model`.

## The tunnel stays yours

`argo-down` exists so that nothing on your machine can reach Argo until you say so, and the harness
honours that: it never opens the tunnel by itself.

| command | |
|---|---|
| `/argo` | status: user, port, up or down, models registered, this session's spend |
| `/argo up` | runs `argo-up`; its progress appears in the chat and the Duo prompt becomes a dialog — type `1`, approve the push. After a Duo the bastion channel stays open about four hours, so later `/argo up`s need no push |
| `/argo down` | runs `argo-down`: the port closes, the models unregister, the column says `⚡ argo down` |
| `/argo spend` | argo-dash's usage report: `--once` from the proxy log while the tunnel is up, the local ledger otherwise |
| `/argo check` | one one-token request per Claude model (`/argo check all` for every model) to find listed models that do not answer, and drop them from `/model` |
| `/argo reload` | re-read the catalogue (after bringing the tunnel up in a terminal) |

## It is badged, and priced

While the session is on Argo, the column's `ENDPOINT` row reads **`⚡ argo`** in a warning colour,
for two reasons: Argo is metered, and argo-proxy can log request bodies in plaintext on a shared
node (that is what makes token accounting possible). `/round` does not use Argo by default.

Spend is priced the way argo-dash prices it, from the dash's own table, so the two tools agree.
The column's `USAGE` row shows the session's dollars and `/argo` says them in words. The figure is
marked `≈` because argo-proxy streams Claude's prompt tokens as zero; the harness substitutes Pi's
estimate, which also keeps the context gauge and auto-compaction working on Argo. `/argo spend`
has the exact input and cache counts from the proxy log.

## When a model answers nothing

Argo's catalogue still lists some retired models. Streaming one returns no events at all, which Pi
reports as "stream ended without a stop reason". The harness says once what that means, and
`/argo check` finds every such model. It costs one token per model, so it runs only when asked.

The full background — the pty relay that carries the Duo prompt, the pricing, the measurements —
is in the vault note `pi-lab-profile-vault/extensions/argo.md`, and setup is in
[setup-guide.md §16](setup-guide.md#16-argo-frontier-models-through-argo-tools).
