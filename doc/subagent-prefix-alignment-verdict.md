# Feasibility: post-run subagent prefix-alignment verdict

## Current completion path

Foreground PARALLEL children are dispatched by `runForegroundParallelTasks()` and return `SingleResult[]` (`src/runs/foreground/subagent-executor.ts:2526-2642`). `runParallelPath()` then compacts those results into tool details and aggregates child outputs (`:2912-3022`). Async runs publish child results through their run artifacts/status path instead. Neither completion path currently computes prompt-prefix commonality.

`SingleResult` exposes usage, effective model, session/transcript paths, and child output (`src/shared/types.ts:648-692`), but not telemetry segment sizes or cache-request identifiers. The runtime result therefore cannot produce the analyzer's system/tools-segment alignment measurement by itself. The offline `pi-session-analysis` pipeline is a separate consumer of persisted sessions and cache telemetry; pi-subagents has no telemetry reader or analyzer dependency in this completion path.

## Feasibility and limits

A post-run *size proxy* is feasible, but not directly with today's result shape. It would need to correlate each child session with cache telemetry after records are flushed, read segment byte lengths, and attach a best-effort result to both foreground and async completion artifacts. The data is asynchronous and may be absent for legacy sessions or failed/short runs, so the surface must distinguish `measured`, `unavailable`, and `incomplete` rather than report false alignment.

The current telemetry records segment byte lengths, not segment contents. Equal lengths are only a weak alignment signal; unequal lengths prove a difference, but equal lengths do not prove byte equality. Thus a runtime verdict cannot honestly claim exact shared-prefix bytes without new, privacy-reviewed instrumentation. The analyzer's offline output is more appropriate for robust cohort comparisons and can evolve without putting filesystem joins or analysis cost on every tool call.

## Recommendation

Do not add a runtime verdict in this guidance change. First land the offline analyzer and collect complete post-deploy sibling groups. If agents need immediate feedback later, add an optional, explicitly approximate size-proxy field only after a stable telemetry lookup API exists; keep cohort attribution and exact commonality in the offline analyzer. Any runtime implementation should remain non-blocking and should never delay returning the parallel result while waiting for telemetry.
