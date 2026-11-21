# Parent-written async startup status

## Change

The parent now atomically writes an initial status record immediately after creating an async run directory. The record uses the existing `AsyncStatus` state `queued` plus optional `startupPhase: "starting"`, preserving compatibility with existing readers. Validation/spawn failures overwrite it with `state: "failed"`, `startupPhase: "spawn_error"`, and the error text. Validation failures retain the run directory instead of deleting the only forensic record. The child runner continues to replace the marker with its normal status payload.

Tests that previously assumed no status file existed before child startup now distinguish the parent startup marker from child status and wait for child status fields before consuming session identity or chain metadata.

## Changed files

- `src/runs/background/async-execution.ts`
- `src/shared/types.ts`
- `test/integration/async-execution.test.ts`
- `test/integration/intercom-result-delivery.test.ts`

## Validation

- `npm ci`: passed.
- Focused startup/status integration tests: 3 passed, 0 failed (normal child transition, missing-cwd validation failure, simulated spawn failure).
- Solo `node --experimental-strip-types --test test/integration/async-execution.test.ts`: 100 passed, 1 failed. The only failure is the pre-existing top-level async worktree parallel test (confirmed by parent on base and sibling tree).
- Focused intercom startup-status integration test: 1 passed, 0 failed.
- `npm run test:unit`: 1,734 total; 1,732 passed, 1 failed, 1 skipped. The failure is the known base failure `published extension APIs use supported package entrypoints` (protocol version expectation 1 vs base export 2).
- `npm run test:integration`: 661 total; 654 passed, 5 failed, 2 skipped. The failures are the known pre-existing async-worktree test and four fork-context model-scope tests; the additional intercom failure caused by observing the startup marker was fixed by waiting for child status and then passed in the full rerun.
- `git diff --check`: passed.

## Residual risks

- Full integration suite remains red only on the five listed baseline failures; the parent verified the async-worktree failure on untouched main, and fork-context failures are known on this base.
- The compatibility representation intentionally uses `state: "queued"` plus `startupPhase` rather than extending the established state enum with `starting`/`spawn_error`; this avoids breaking status consumers while making parent-side startup state explicit.

# Pending async subagent results

## Change

This change adds a best-effort pending-results sweep at `agent_settled`. Async completion and `session_compact` events mark the sweep dirty; a successful scan with no pending runs emits nothing. Completion notices and sweep notices write a per-run `completion-ack.json` marker only when `message_start` confirms the parent began consuming the message. This makes repeated sweeps idempotent while allowing an appended-but-unseen notice to be recovered.

The sweep filters the current session's terminal runs, checks the persisted ack marker and the existing in-memory `consumedCompletionRuns`, and scans retained session entries for `subagent-notify` run IDs. Matching history entries are folded into the same bounded `Pending results: N` message and labeled as recovered. The message is capped at 24 child lines / 4,000 characters; skipped and unreadable history/ack/status paths are recorded in `subagent_pending_results_sweep` entries.

## Hook boundary

pi-tau `1fe9c16` requeues retained **background-job** completion notices into its wake-visible queue when host delivery is stale or canceled. This change does not modify that queue: it sweeps pi-subagents' **async-run status registry**, whose terminal result notices and acknowledgements are separate. No dedicated post-compaction callback was needed; `session_compact` marks the sweep dirty and the next `agent_settled` performs it.

## Changed files

- `src/extension/index.ts`
- `src/runs/background/pending-results.ts`
- `src/runs/background/pending-results-sweep.ts`
- `test/unit/pending-results.test.ts`
- `REPORT.md` (this section; the existing parent-written report is preserved above)

## Validation

- `npm ci`: passed.
- Focused tests (`node --experimental-strip-types --test test/unit/pending-results.test.ts test/unit/notify.test.ts`): 33 passed, 0 failed.
- `npm run test:unit` on commit `26c9b118`: 1,756 total; 1,754 passed, 1 failed, 1 skipped. The sole failure is the known pre-existing `package-manifest.test.ts` protocol-version expectation (`2 !== 1`).
- `npm run test:integration`: 661 total; 659 passed, 0 failed, 2 skipped.
- `git diff --check`: passed. LSP diagnostics on both new modules and the new test: clean. `src/extension/index.ts` retains the base's existing `view` type mismatch diagnostic, unrelated to this change.

## Residual risks

- The status registry scan is best-effort; an unreadable registry prevents that sweep and increments telemetry for retry on a later wake.
- No live deployed-runtime probe was run in this worker branch; the parent should probe delivery/ack recovery after merge and deploy.
