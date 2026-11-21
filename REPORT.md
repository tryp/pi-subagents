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
