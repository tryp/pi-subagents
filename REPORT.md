# Completion notification error preview

Branch: `fix-notify-error-preview` (base `bb0e421c`)

## Change

Failed completions with an empty/whitespace summary now use the first line of a failed child step's `error` in the preview, formatted as `(failed: <error>)`. If no step error is available, the top-level completion `error` is used. Multiple failed steps retain each error with its agent label. Non-empty summaries, paused results, and successful previews remain unchanged.

## Files

- `src/runs/background/notify.ts`
- `test/unit/notify.test.ts`

## Validation

- `npm ci`: passed (reported 9 dependency audit vulnerabilities; no dependency changes made).
- `node --experimental-strip-types --test test/unit/notify.test.ts`: **28 passed, 0 failed**.
- `npm run test:unit`: **1,736 passed, 1 failed, 1 skipped** (1,738 total). The sole failure is the known base failure `test/unit/package-manifest.test.ts` expecting background-work protocol version 1 while base exports version 2.
- `npm run test:integration`: **654 passed, 5 failed, 2 skipped** (661 total). Four failures are pre-existing fork-context warning-count assertions that the sibling model-scope lane adjusts to filter unrelated warnings. One async worktree test failed on a missing `observed-cwd.txt` artifact and reproduced when run alone; neither failure touches notification code.
- `git diff --check`: passed.
- LSP diagnostics for changed files: clean after `npm ci`.

## Residual risks

- The full unit and integration suites are not green on this base for the unrelated failures listed above. The focused notification suite is green; this branch only changes notification implementation and tests.
