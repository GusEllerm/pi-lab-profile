---
documented: 2026-09-20
outcome: fixed
---

# The scroll stall (Sept 2026)

**Symptom, in the user's words:** "the terminal is not responding for a beat, and then it catches up",
while scrolling a large session. Turning the status column off made it smooth.

**Answer:** two independent bugs, neither in this repo's logic.

1. The transcript was rendered **twice per frame**, because an hstack measures children it then
   stretches, and measuring a `ScrollView` renders its whole document.
2. Every **mouse motion** made pi-cc walk the message tree at the *terminal* width while the transcript
   was laid out narrower. pi-tui's `Text` caches one `(text, width)` pair, so that walk evicted every
   cached line in the session and the next frame rebuilt all 2,846 of them.

Result after fixing: worst transcript render **133ms → 3.7ms**, worst frame 145ms → 38ms, no frame over
40ms in 775 frames of scrolling. Mechanics in [[../architecture/upstream-workarounds]].

## Why it is written up

The conclusion is worth two paragraphs. The **method** is worth the rest, because this took far longer
than it should have and the reasons are reusable.

## What was wrong, and what killed each idea

Eight hypotheses, each plausible, each argued confidently, each killed by a measurement:

| # | hypothesis | killed by |
|---|---|---|
| 1 | iTerm's Metal renderer disabled on battery | Metal was active; iTerm at 35% CPU against pi's 115% |
| 2 | The sidebar memo key was too expensive | fixed a real bug; a fresh process still peaked at 122% |
| 3 | The narrower transcript wraps more lines | user tested `/sidebar 20` — still 111–115% |
| 4 | A `visible()` hook re-arming a forced full repaint | instrumented: 287 layout passes, **zero** width mismatches |
| 5 | `terminal.write` blocking on a slow terminal | measured: write is **1–3%** of frame time |
| 6 | The `invalidate()` cascade re-parsing markdown | wrapped `invalidate()`: called **never** |
| 7 | A garbage-collection pause | `PerformanceObserver`: nothing over 15ms |
| 8 | One expensive message | bisect: cost spread across *every* message |

Each elimination was cheap. Each argument that preceded it was wrong. The lesson is not "I was unlucky"
— it is that in a system this layered, **plausibility is worthless and instrumentation is decisive**.

## The three mistakes that cost the most time

**Testing with the wrong input.** Every synthetic reproduction used *wheel* events, and wheel events
never trigger this. The moment the trace named a hover handler, one run with SGR **motion** events
reproduced it. Days of "my harness says it's fine, the user says it stalls" came down to sending the
wrong bytes.

**Measuring the wrong layer.** `/prof` initially timed only the status column, which measured 0.49ms
and looked innocent — and *was* innocent. The column's cost was never the point; its **presence**
changed what happened around it. Profile the frame, not your component.

**The instrument became the experiment.** The profiling wrappers were versioned, and each `/reload`
with a new version **stacked another wrapper** instead of replacing one. After four reloads every
message rendered through four nested timers: 2.1ms → 61.6ms per document render, 75ms frames, and a
nonsensical `22787ms` of child time reported inside a 121ms render. The user reported it as "extremely
laggy" — correctly, and it was the profiler. The arithmetic was impossible on its face and should have
been spotted immediately. See invariant 2 in [[../00-start-here]].

## What actually found it

A detector for *any child rendered at a width other than the document's*, capturing a stack:

```
rendered at the wrong width: Container at 187 (doc is 151):
  componentAtLocalRow ← cachedFullscreenComponentAtRow ← handleFullscreenToolHover ← tui.handleViewportInput
```

One line, and the bug was named. Two details made that possible, both worth copying:

- **The stall reproduced to the millisecond** — `129ms, 2846 lines, same width` twice running. Pauses
  (GC, scheduler, terminal) are jittery; deterministic cost is *work*. That single observation killed
  the entire "find the pause" framing and reframed it as "find the function".
- **Same input, same output, no invalidation** — the render produced an identical line count at an
  identical width having done no new work. That can only be cache misses, which points at eviction,
  which points at a second width.

## Measurements worth keeping

From a real ~2,850-line session, for future comparison:

| | |
|---|---|
| frame, typical | 14ms, ~29 rows repainted, ~330 bytes a row |
| `terminal.write` share of a frame | 1–3% |
| transcript document render, cache warm | 0.8–1.1ms |
| transcript document render, caches evicted | **~130ms** |
| status column render | 0.25ms, 95% cache hits |
| bytes per scroll window | ~2.4MB (not a bottleneck) |

`/prof` still reports all of these. It is cheap now, and it is the right first move for any future
"feels slow" report — before forming a hypothesis, not after.

## Loose ends

- pi-cc's hover still hit-tests at the wrong width whenever it runs, so **"click to show more" lands on
  nothing** in a split layout. No local patch fixes the row→component mapping; it needs the upstream
  one-liner. Written up in `docs/upstream-hover-width.md`, not yet filed.
- The workarounds here are workarounds. Three canary tests assert the upstream bugs are still present
  so that a fix upstream shows up as a **failing test**, which is the signal to delete the workaround
  rather than keep it. See [[../architecture/upstream-workarounds]].
