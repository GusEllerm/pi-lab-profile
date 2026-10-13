# Endpoints: where inference comes from

Globus Harness is built for a lab whose inference comes from several places at once, each with
its own latency, cost and trust. The `lab` profile configures all of them; each needs a credential
only you can obtain, and the harness picks it up the moment it is in place. None is required.

| endpoint | providers in `/model` | what it is like |
|---|---|---|
| **Lab GPUs** — a vLLM server on the Globus Labs cluster, through an SSH tunnel | `globus/qwen3.8-flash-next` (the default) | private and unmetered; one model, shared by the whole lab (eight requests at once in total) |
| **ALCF inference gateway** — Argonne's service on Minerva, Metis and Sophia | `alcf-minerva/…`, `alcf-metis/…`, `alcf-sophia/…` | many open-weight models; a *cold* model starts on its first request and can take minutes |
| **Argo** — Argonne's gateway to Claude, GPT and Gemini, through a Duo-protected tunnel | `argo/claude-…`, `argo-openai/…` | frontier models, **metered**; see [argo.md](argo.md) |

HPC compute (hpc-bridge) is not inference and has its own page: [hpc.md](hpc.md).

## Getting access

| endpoint | what you set up | who grants it | check |
|---|---|---|---|
| **Lab GPUs** | a `Host globus1` block in `~/.ssh/config` with your cluster username and key; `ssh globus1 true` must succeed without a prompt (or set `GLOBUS_TUNNEL_HOST=<user>@<host>`), plus the `pi()` launcher from [setup-guide.md §6](setup-guide.md#6-the-launcher-function) | a cluster account, from the lab | `pi --no-session -p "Reply with just: ok" </dev/null` opens the tunnel and prints `ok` |
| **ALCF** | `uvx alcf-ai auth login` once, in a browser; the refresh token lasts about six months idle. `models.json` runs `~/.local/bin/alcf-token` per request, so nothing secret sits in config | gateway access under your Globus identity, from ALCF | `alcf-token --status`, then `/endpoints` |
| **Argo** | `git clone https://github.com/GusEllerm/argo-tools && cd argo-tools && ./argo-setup` | a CELS account with an SSH key and Duo, plus Argo Gateway API authorisation from your division's AIOps representative | `/argo up`, then `/argo` |

## Seeing what is reachable: `/endpoints`

`/endpoints` probes every provider at once and opens immediately, one folder per machine, each
folder summarised (`3 live`, `11 live · 6 queued · 6 cold`) and filling in as answers land. → opens
a folder, ← closes it, Enter on a model switches the session to it.

| state | means |
|---|---|
| `● up` / `○ absent` | the lab GPU serves this model / does not (the tunnel is up but another model is loaded) |
| `? down` | nothing answers — for the lab GPU, usually the tunnel: `globus-tunnel ensure` |
| `● live` · `◌ queued` · `○ cold` | an ALCF model is running, waiting for nodes, or will start on its first request |
| `? no auth` | no ALCF token; the row says why (`alcf-token --status`) |
| `(served, not in models.json)` | the machine offers a model your config does not declare; add it to use it |

## Knowing which one answered

The column's `ENDPOINT` row names the endpoint behind the current model (`globus3`,
`ALCF Minerva`, `⚡ argo`) and marks it ✓ or ✗ from its last reply. `MODEL` sits above it, and the
footer carries the same when the column is hidden. Switching with `/model`, Ctrl+P or
`/endpoints` updates both at once.

## Adding your own

The extensions do not care which providers you have: anything in `~/.pi/agent/models.json` shows
up in `/endpoints` and the column, labelled from its `name`. The `example` profile starts with no
lab endpoints at all. Pi's [models documentation](https://pi.dev) covers the file format; the
lab's `profiles/lab/models.json` is a worked example, including the `thinkingLevelMap` a vLLM
model usually needs and the `compat` block the ALCF gateway needs.
