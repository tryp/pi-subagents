# Bare subagent model resolution implementation

Branch: `fix-bare-model-scope`  
Base: `bb0e421c`  
Implementation commit: `293242d8` (`fix(models): honor enabled scope for bare subagent ids`)

## Resolution path

The subagent tool's `params.model` reaches `runSinglePath` at `src/runs/foreground/subagent-executor.ts:3263`, where `resolveEffectiveSubagentModel` is called with the full registry snapshot (`:3260`). It flows through `src/runs/shared/model-fallback.ts:226` (`resolveSubagentModelOverride`) to `resolveModelCandidate` (`:248`). Previously that path used fuzzy/partial matching over all providers, so registry order could select keyless `amazon-bedrock` for `gpt-6-luna`.

Management warnings and other model-selection entry points use the same `resolveScopedModelInfo` helper at `src/shared/model-info.ts:62`, through `findModelInfo` (`:95`) and `resolveModelCandidate` (`src/runs/shared/model-fallback.ts:140`). Call sites now pass session `ctx.scopedModels` and the registry auth check where available, including agent management, profile switching, and watchdog selection/review.

## Implemented precedence

- Qualified `provider/model` requests keep provider identity and match that provider only; enabled scope does not redirect them.
- Bare ids resolve against `ctx.scopedModels` first, matching the session's enabled-model list.
- Without an enabled match, candidate models are filtered using `modelRegistry.hasConfiguredAuth`. A match only under unauthenticated providers produces an explicit resolution error.
- Remaining ambiguity is resolved deterministically by preferred provider, then provider/id lexical order; unresolved ambiguity emits a warning naming the selected model and alternatives.
- Known `:thinking` suffixes are preserved.

## Validation

- `npm ci`: passed.
- `node --experimental-strip-types --test test/unit/model-info.test.ts test/unit/model-fallback.test.ts`: **62 passed, 0 failed**; covers four-provider enabled selection, qualified selection, unauthenticated fallback rejection, deterministic warned fallback, and thinking suffix handling.
- `npm run test:integration`: **661 total, 659 passed, 0 failed** (2 skipped).
- `git diff --check`: passed.
- `npm run test:unit`: **1740 total, 1738 passed, 1 failed**. The unrelated existing failure is `test/unit/package-manifest.test.ts`: it expects `BACKGROUND_WORK_PROTOCOL_VERSION === 1`, while the base branch exports version `2` from `src/api/background-work.ts`.
- `npm run test:e2e`: **5 total, 4 passed, 1 failed** at `test/e2e/supervisor-idle-wake.test.ts:111` (“idle parent should start a new model turn without another user prompt”).
- `npx tsc --noEmit`: failed on existing type errors in untouched tests/API fixtures; no diagnostics were reported under the changed source files.
- No lint/typecheck script is configured in `package.json`.

## Files changed

- `src/shared/model-info.ts`
- `src/runs/shared/model-fallback.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/agents/agent-management.ts`
- `src/slash/slash-commands.ts`
- `src/watchdog/model-selection.ts`
- `src/watchdog/review.ts`
- `test/unit/model-info.test.ts`
- `test/unit/model-fallback.test.ts`
- `test/integration/fork-context-execution.test.ts` (scope-warning assertions now filter unrelated concurrent test warnings)

Residual risks: the full unit suite, repository typecheck, and one unrelated e2e remain red as detailed above. Bare fuzzy spellings that do not exactly match a model id still use the pre-existing fuzzy fallback path; the reported `gpt-6-luna` exact-id failure is covered by the scoped resolver.
