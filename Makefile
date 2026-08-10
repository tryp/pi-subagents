# pi-subagents deployment helpers.
#
# This checkout (~/src/pi-subagents) is the development source of truth. Pi
# loads the extension from the deployed content mirror at $(RUNTIME_DIR), not
# from this checkout. Never edit the runtime copy directly; change files here,
# commit them, run `make deploy`, and restart/reload Pi as appropriate.
#
#   make deploy            # test-independent mirror, install runtime deps, stamp, verify
#   make verify            # verify content and deployed commit marker
#   make deployed-commit   # show the deployed source commit

RUNTIME_DIR ?= $(HOME)/.pi/agent/local/pi-subagents

# Runtime-only files and directories. node_modules is installed separately in
# the deployed copy so the source checkout and runtime dependencies remain
# independent.
RSYNC_EXCLUDES := \
	--exclude '.git/' \
	--exclude 'node_modules/' \
	--exclude 'tmp/' \
	--exclude '.deployed-commit'

.PHONY: deploy verify deployed-commit

deploy:  ## Mirror this checkout into the local Pi runtime and verify it
	@test -z "$$(git status --porcelain)" || { echo "ERROR: commit source changes before deploying" >&2; git status --short >&2; exit 1; }
	@test -d "$(RUNTIME_DIR)" || mkdir -p "$(RUNTIME_DIR)"
	@deleting=$$(rsync -nrc --delete $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/" | grep '^deleting ' || true); \
	if [ -n "$$deleting" ]; then \
		echo "ERROR: $(RUNTIME_DIR) contains files not present in this checkout:" >&2; \
		echo "$$deleting" >&2; \
		echo "Move or remove them before deploying (they would be lost)." >&2; \
		exit 1; \
	fi
	rsync -a --delete $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/"
	npm ci --omit=dev --ignore-scripts --prefix "$(RUNTIME_DIR)"
	@printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\n\nThis is a deployed artifact. Do not edit files here.\nEdit the source checkout and run `make deploy`.\n' \
		"$(CURDIR)" "$$(git rev-parse --abbrev-ref HEAD)" "$$(git rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" \
		> "$(RUNTIME_DIR)/.deployed-commit"
	@$(MAKE) --no-print-directory verify

verify:  ## Verify the deployed mirror matches this checkout
	@test -d "$(RUNTIME_DIR)" || { echo "ERROR: $(RUNTIME_DIR) missing" >&2; exit 1; }
	@test -f "$(RUNTIME_DIR)/.deployed-commit" || { echo "ERROR: no .deployed-commit marker in $(RUNTIME_DIR)" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' "$(RUNTIME_DIR)/.deployed-commit")" = "$$(git rev-parse HEAD)" || { \
		echo "ERROR: deployed commit != checkout HEAD" >&2; exit 1; }
	@diff=$$(rsync -nrc $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/" 2>&1); rc=$$?; \
	if [ $$rc -ne 0 ] && [ $$rc -ne 1 ]; then echo "rsync error: $$diff" >&2; exit 1; fi; \
	if [ -n "$$diff" ]; then echo "ERROR: content drift:" >&2; echo "$$diff" >&2; exit 1; fi
	@echo "OK: $(RUNTIME_DIR) matches $(CURDIR) @ $$(git rev-parse --short HEAD)"

deployed-commit:  ## Show which source commit is deployed
	@cat "$(RUNTIME_DIR)/.deployed-commit" 2>/dev/null || echo "no .deployed-commit marker"
