# Deploy local pi-subagents fork over the npm-installed package.
# Pi loads extension .ts files via tsgo at runtime, so changes take
# effect on next pi start after deploy.

NPM_INSTALL = $(HOME)/.pi/agent/npm/node_modules/pi-subagents

.PHONY: deploy verify

deploy:
	# First update the npm package's package.json to match our fork version
	cp package.json $(NPM_INSTALL)/
	# Deploy source tree (preserves files not in our fork, like agents/*.md)
	rsync -a --delete src/ $(NPM_INSTALL)/src/
	# Sync skills, prompts, agents dirs
	rsync -a --delete agents/ $(NPM_INSTALL)/agents/
	rsync -a --delete skills/ $(NPM_INSTALL)/skills/ 2>/dev/null || true
	rsync -a --delete prompts/ $(NPM_INSTALL)/prompts/ 2>/dev/null || true

verify:
	@echo "=== Model inheritance fix ==="
	grep -n "resolveSubagentModelOverride\|inherit parent" $(NPM_INSTALL)/src/runs/shared/model-fallback.ts
	@echo "=== Models action ==="
	grep -n "case.*models" $(NPM_INSTALL)/src/agents/agent-management.ts
	@echo "=== Tool prompt guidelines ==="
	grep -n "registerToolPromptGuidelines" $(NPM_INSTALL)/src/extension/index.ts
	@echo "=== Model info in list ==="
	grep -n "modelLabel\|modelLines" $(NPM_INSTALL)/src/agents/agent-management.ts || true
	@echo "Deploy verify complete."
