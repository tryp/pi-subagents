# Intercom completion target resolution

## Change

The completion target fallback now matches pi-intercom's registered-name rule: when `getSessionName()` is empty, both sides use the first 18 session-id characters. pi-subagents previously used only 8, causing its completion steer to address `subagent-chat-01a1ff05` instead of the registered `subagent-chat-01a1ff05-1514-77d7`. Explicit session names remain unchanged.

Result payloads now carry the short derived candidate and full registered target name; unacknowledged foreground and async deliveries log both values. This makes route failures attributable while retaining the current fallback behavior.

## Changed files

- `src/intercom/intercom-bridge.ts`
- `src/intercom/result-intercom.ts`
- `src/runs/background/result-watcher.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/shared/types.ts`
- `test/unit/intercom-bridge.test.ts`
- `test/unit/result-intercom.test.ts`
- `test/integration/intercom-result-delivery.test.ts`

## Validation

- `npm ci`: passed.
- Focused unit tests (`intercom-bridge`, `result-intercom`): 26 passed, 0 failed, 0 skipped.
- Focused integration (`intercom-result-delivery.test.ts`): 30 passed, 0 failed, 0 skipped.
- `npm run test:unit`: 1,754 total; 1,752 passed, 1 failed, 1 skipped. The only failure is the known baseline `package-manifest.test.ts` expectation (protocol version mismatch).
- `npm run test:integration`: 661 total; 659 passed, 0 failed, 2 skipped.
- `git diff --check`: passed.

## Residual risks

- The known package-manifest unit failure remains; this change does not touch that code.
- The registered-name fallback length (18) must remain aligned with pi-intercom's `resolveIntercomPresenceName` implementation.
