# Parent-written async startup status

## Change

The parent now atomically writes an initial status record immediately after creating an async run directory. The record uses the existing `AsyncStatus` state `queued` plus optional `startupPhase: "starting"`, preserving compatibility with existing readers. Validation/spawn failures overwrite it with `state: "failed"`, `startupPhase: "spawn_error"`, and the error text. Validation failures retain the run directory instead of deleting the only forensic record. The child runner continues to replace the marker with its normal status payload.

## Changed files

- `src/runs/background/async-execution.ts`
- `src/shared/types.ts`
- `test/integration/async-execution.test.ts`

## Validation

- `npm ci`: passed.
- Focused startup/status integration tests: 3 passed, 0 failed (normal child transition, missing-cwd validation failure, simulated spawn failure).
- `npm run test:unit`: 1,734 total; 1,732 passed, 1 failed, 1 skipped. The failure is the known base failure `published extension APIs use supported package entrypoints` (protocol version expectation 1 vs base export 2).
- `npm run test:integration`: 661 total; 651 passed, 8 failed, 2 skipped. Failures were in existing dynamic-status/worktree/subagent-wait and fork-context/intercom tests; these were not independently verified against base in this task. The startup-specific tests passed.
- `git diff --check`: passed.

## Residual risks

- Full integration suite remains red (8 failures); they are outside the changed startup-status paths but have not all been independently compared against base.
- The compatibility representation intentionally uses `state: "queued"` plus `startupPhase` rather than extending the established state enum with `starting`/`spawn_error`; this avoids breaking status consumers while making parent-side startup state explicit.
