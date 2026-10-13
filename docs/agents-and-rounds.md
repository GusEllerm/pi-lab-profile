# Agents and review rounds

[pi-subagents](https://github.com/tintinweb/pi-subagents) gives Pi an `Agent` tool that starts
subagents — Explore, Plan, general-purpose, or roles you define. Globus Harness gives them a
control surface, and uses them to review changes with more than one model.

## The fleet

The list under the editor shows every subagent: its turns, tool calls, tokens and context, its
rate, how long it has run, and what it is doing right now (`→ bash`).

| key (prompt empty) | does |
|---|---|
| ↓ or ← | focus the list |
| ↑ ↓ | move |
| **Enter** | **attach**: the transcript and the column become that agent's, and what you type steers it |
| `s` | send one steering message |
| `m` | move it to another endpoint (`/agent-model`) |
| Esc | detach, or leave the list |

Typing anything else lets go of the list and goes to the editor. To stop an agent, use
pi-subagents' viewer: `/agents` → the agent → `x`.

- **`/attach [agent]`** and **`/attach main`** do the same from the prompt.
- **`/agent-model [agent] [provider/model]`** moves a *running* subagent to another endpoint
  mid-run — off a cold ALCF model onto the lab GPU, say.
- **`/open`** lists everything substantial that the agent you are looking at produced —
  reasoning, `!bash` runs, edits as diffs, writes — in full, in a picker, with a hand-off to
  `$EDITOR`. The transcript truncates long output; the session keeps it, and `/open` reads the
  session.

The lab's `subagents.json` caps concurrency (three at once, two in the foreground) because the lab
GPU is shared.

## Review rounds

`/round <task>` puts a change through three roles, each on a model of your choosing:

1. **dev** implements the task — on the session's model unless configured otherwise
2. a **review panel** of two reviewers on *different weights* reads the diff; two copies of one
   model share their blind spots
3. a **critic** checks every finding against the code and discards what does not hold

The report goes to `.pi/rounds/<timestamp>.md` and the verdict into the session, so the main model
can act on it.

| command | |
|---|---|
| `/round <task>` | the full round |
| `/round --rounds 2 <task>` | hand what survived the critic back to dev for another pass |
| `/round --reviewers 1 <task>` | one reviewer instead of the panel |
| `/review [focus]` | no dev phase: review the working tree as it stands, then verify the review |
| `/rounds` | past reports; bring one back into the conversation |
| `/round status` · `/round stop` | where a round is; end it |

### Choosing the models: `rounds.json`

Project `.pi/rounds.json` first, then `~/.pi/agent/rounds.json`. The lab's:

```json
{
  "dev": null,
  "panel": [
    { "label": "reviewer A", "model": "alcf-minerva/gpt-oss-120b" },
    { "label": "reviewer B", "model": "alcf-minerva/nemotron-3-ultra" }
  ],
  "critic": "alcf-metis/gpt-oss-120b",
  "timeoutMinutes": 20
}
```

A seat with no model inherits the session's, and a model this machine cannot resolve falls back
the same way, so a config written for another cluster degrades instead of failing. The role files
in `agents/` never pin a model; this file is the only place endpoints are decided. `/round`
deliberately leaves Argo out: it is metered.

### What a bake-off taught us

From three diffs on the lab's gateway — two with planted bugs, one clean, every claim re-run
against the code — a shape to expect rather than a ranking to copy:

- The accuracy that matters most is on the **clean** diff. A reviewer that invents defects costs
  more than one that finds none.
- One 675B model produced four high-confidence false findings and was dropped. A 31B model was as
  accurate as a 120B and six times faster.
- Size predicted the depth of an explanation, not its correctness.

Run your own before trusting a model in the critic seat.
