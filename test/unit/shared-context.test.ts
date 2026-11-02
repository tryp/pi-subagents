import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSharedContextPreamble, SHARED_CONTEXT_CLOSE_DELIMITER, SHARED_CONTEXT_OPEN_DELIMITER } from "../../src/runs/shared/shared-context.ts";

describe("shared context preamble", () => {
	it("preserves nonempty source bytes literally and adds only fixed delimiters", () => {
		const sharedContext = "  {task}\n{previous}  ";
		assert.equal(
			formatSharedContextPreamble(sharedContext),
			`${SHARED_CONTEXT_OPEN_DELIMITER}\n${sharedContext}\n${SHARED_CONTEXT_CLOSE_DELIMITER}\n\n`,
		);
	});

	it("adds no prompt bytes for omitted or empty shared context", () => {
		assert.equal(formatSharedContextPreamble(undefined), "");
		assert.equal(formatSharedContextPreamble(""), "");
	});
});
