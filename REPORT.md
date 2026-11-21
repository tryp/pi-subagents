# Execute-class completion guard

## Changes

- Added the dispatch-level `workClass: "implement" | "execute"` parameter. It applies consistently to foreground single runs, background single runs, and all children/steps of parallel and chain dispatches.
- The shared completion guard honors a declared class deterministically: `execute` allows zero-edit completion; `implement` requires an observed mutation. Undeclared tasks retain the implementation-intent guard, with narrowly explicit execution/adjudication task wording classified as non-implementation.
- Guard failures now explain the remedy: declare `workClass: "execute"` for execution/adjudication tasks.
- Added the peer's complete task text as a regression fixture. It classifies as execution and a zero-edit receipt/report no longer trips the guard.
- Added foreground and background integration tests for declared execute-class success, while existing tests continue to verify that implementation tasks with no edits fail.
- Kept the serialized SubagentParams schema under its hard 16 KiB ceiling: 16,376 bytes.

## Files changed

- `src/extension/schemas.ts`
- `src/runs/background/async-execution.ts`
- `src/runs/background/subagent-runner.ts`
- `src/runs/foreground/execution.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/shared/completion-guard.ts`
- `src/runs/shared/parallel-utils.ts`
- `src/runs/shared/task-intent.ts`
- `src/shared/settings.ts`
- `src/shared/types.ts`
- `test/fixtures/execute-class-false-positive-task.txt`
- `test/integration/async-execution.test.ts`
- `test/integration/single-execution.test.ts`
- `test/unit/completion-guard.test.ts`
- `test/unit/schemas.test.ts`
- `test/unit/task-intent.test.ts`

## Validation

- Focused unit suites (`task-intent`, `completion-guard`, `schemas`): **42 passed, 0 failed**.
- `npm run test:unit`: **1,760 passed, 1 failed, 1 skipped**. The sole failure is the known pre-existing `test/unit/package-manifest.test.ts` provider-count mismatch (`expected 1, got 2`; protocol-version mismatch), also observed on base.
- `npm run test:integration`: **661 passed, 0 failed, 2 skipped**.
- Targeted dynamic/fork integration files after correcting optional-field propagation: passed.
- `git diff --check`: clean.

## Residual risks

- The pre-existing package-manifest unit failure remains; it is unrelated to these files.
- No separate TypeScript build/typecheck was run; unit and integration suites use the repository's TypeScript runtime harness.
