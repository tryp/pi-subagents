# pi-subagents deployment helpers.
#
# This checkout (~/src/pi-subagents) is the development source of truth. Pi
# loads the extension from the deployed content mirror at $(RUNTIME_DIR), not
# from this checkout. Never edit the runtime copy directly; change files here,
# commit them, run `make deploy`, and restart/reload Pi as appropriate.
#
#   make deploy            # mirror, install deps, stamp, verify, and smoke-test
#   make verify            # verify content and deployed commit marker
#   make smoke-test        # load only this deployed extension in a fresh pi
#   make deployed-commit   # show the deployed source commit
#   make drift             # check whether the runtime changed since deploy
#
# ALLOW_DRIFT=1 make deploy tolerates modified runtime files after preserving
# them; extra runtime files always refuse deployment.

RUNTIME_DIR ?= $(HOME)/.pi/agent/local/pi-subagents
ALLOW_DRIFT ?=
SMOKE_SCRIPT ?= /home/dev/src/pi-session-analysis/scripts/predeploy_smoke.py
SMOKE_TIMEOUT ?= 90

# Runtime-only files and directories. node_modules is installed separately in
# the deployed copy so the source checkout and runtime dependencies remain
# independent.
RSYNC_EXCLUDES := \
	--exclude '.git/' \
	--exclude 'node_modules/' \
	--exclude 'tmp/' \
	--exclude '.deployed-commit' \
	--exclude '.deploy.lock'

.PHONY: deploy deploy-locked drift verify smoke-test deployed-commit

deploy:  ## Mirror this checkout, verify it, and smoke-test the deployed extension
	@test -z "$$(git status --porcelain)" || { echo "ERROR: commit source changes before deploying" >&2; git status --short >&2; exit 1; }
	@test -d "$(RUNTIME_DIR)" || mkdir -p "$(RUNTIME_DIR)"
	@flock -n -E 75 "$(RUNTIME_DIR)/.deploy.lock" $(MAKE) --no-print-directory deploy-locked || { \
		status=$$?; \
		if [ $$status -eq 75 ]; then echo "ERROR: another deploy holds $(RUNTIME_DIR)/.deploy.lock" >&2; fi; \
		exit $$status; \
	}

deploy-locked:  ## Run the deploy while holding the runtime lock
	@python3 scripts/deploy_drift.py --runtime "$(RUNTIME_DIR)" --source . --save-drift tmp/ $(if $(ALLOW_DRIFT),--allow-drift)
	rsync -a --delete $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/"
	npm ci --omit=dev --ignore-scripts --prefix "$(RUNTIME_DIR)"
	@tree=$$(python3 scripts/deploy_drift.py --runtime "$(RUNTIME_DIR)" --print-tree-hash) || exit $$?; \
	printf 'deployed from: %s\nbranch: %s\ncommit: %s\ntree: %s\ndeployed by: %s@%s pid=%s\ndeployed at: %s\n\nThis is a deployed artifact. Do not edit files here.\nEdit the source checkout and run `make deploy`.\n' \
		"$(CURDIR)" "$$(git rev-parse --abbrev-ref HEAD)" "$$(git rev-parse HEAD)" "$$tree" "$$(id -un)" "$$(hostname)" "$$$$" "$$(date '+%Y-%m-%d %H:%M:%S %z')" \
		> "$(RUNTIME_DIR)/.deployed-commit"
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory smoke-test

smoke-test:  ## Load only the deployed extension in a fresh pi process
	python3 "$(SMOKE_SCRIPT)" --extension "$(RUNTIME_DIR)" --tool subagent \
		--timeout "$(SMOKE_TIMEOUT)" \
		--prompt 'Call subagent with action list, report that it loaded, and stop.'

verify:  ## Verify the deployed mirror matches this checkout
	@test -d "$(RUNTIME_DIR)" || { echo "ERROR: $(RUNTIME_DIR) missing" >&2; exit 1; }
	@test -f "$(RUNTIME_DIR)/.deployed-commit" || { echo "ERROR: no .deployed-commit marker in $(RUNTIME_DIR)" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' "$(RUNTIME_DIR)/.deployed-commit")" = "$$(git rev-parse HEAD)" || { \
		echo "ERROR: deployed commit != checkout HEAD" >&2; exit 1; }
	@diff=$$(rsync -nrc --itemize-changes $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/" 2>&1); rc=$$?; \
	if [ $$rc -ne 0 ] && [ $$rc -ne 1 ]; then echo "rsync error: $$diff" >&2; exit 1; fi; \
	if [ -n "$$diff" ]; then echo "ERROR: content drift:" >&2; echo "$$diff" >&2; exit 1; fi
	@echo "OK: $(RUNTIME_DIR) matches $(CURDIR) @ $$(git rev-parse --short HEAD)"

drift:  ## Check whether the runtime changed since its last deploy
	@stamp_status=0; python3 scripts/deploy_drift.py --runtime "$(RUNTIME_DIR)" --check-stamp || stamp_status=$$?; \
	stamp_commit=$$(sed -n 's/^commit: //p' "$(RUNTIME_DIR)/.deployed-commit" 2>/dev/null); \
	head_commit=$$(git rev-parse HEAD); source_status=0; \
	if [ "$$stamp_commit" = "$$head_commit" ]; then \
		echo "=== Source/runtime comparison ==="; \
		python3 scripts/deploy_drift.py --runtime "$(RUNTIME_DIR)" --source . || source_status=$$?; \
	else \
		echo "Source/runtime comparison skipped: deployed commit differs from checkout HEAD."; \
	fi; \
	if [ $$stamp_status -ne 0 ]; then exit $$stamp_status; fi; \
	exit $$source_status

deployed-commit:  ## Show which source commit is deployed
	@cat "$(RUNTIME_DIR)/.deployed-commit" 2>/dev/null || echo "no .deployed-commit marker"
