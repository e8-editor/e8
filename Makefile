# E8's chores. Cargo does the building; these put the steps together.
#
#   make app                  E8.app, optimised, on V8 (the default engine)
#   make app ENGINE=quickjs   on QuickJS: a smaller app, about 41 MB against 97
#   make check                every test and clippy, on V8 and on QuickJS
#   make tidy                 delete old test programs and caches the build leaves
#
# make app builds target/E8.app; open it, or copy it to /Applications.
# In a git worktree it builds E8.app in the worktree's own folder
# instead, so each branch has an app of its own to open and the main
# checkout's stays as it was, though the worktree builds in the main
# checkout's target (.claude/hooks/share-target.sh).

ENGINE  ?= v8
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
# A worktree's git directory is not the repository's own.
WORKTREE := $(shell [ "$$(git rev-parse --git-dir 2>/dev/null)" != "$$(git rev-parse --git-common-dir 2>/dev/null)" ] && echo yes)
ifeq ($(WORKTREE),yes)
APP     ?= E8.app
else
APP     ?= target/E8.app
endif

ifeq ($(ENGINE),v8)
FEATURES :=
else
FEATURES := --no-default-features --features $(ENGINE)
endif

# QuickJS builds in a target directory of its own: the two engines turn on
# different features of crates they share, so building one in the other's
# directory would rebuild most of the workspace each time.
QUICKJS := CARGO_TARGET_DIR=target/quickjs
QUICKJS_FEATURES := --no-default-features --features quickjs

.PHONY: app clean-app check tidy

app:
	cargo build --release -p e8-gui -p e8-mcp $(FEATURES)
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp target/release/e8-gui $(APP)/Contents/MacOS/
	# Beside it, so agent-shell's agents can use this editor (ADR 0061).
	cp target/release/e8-mcp $(APP)/Contents/MacOS/
	cp crates/e8-gui/macos/E8.icns $(APP)/Contents/Resources/
	sed 's/@VERSION@/$(VERSION)/g' crates/e8-gui/macos/Info.plist > $(APP)/Contents/Info.plist
	codesign --force --deep --sign - $(APP)
	@echo "Built $(APP) ($(ENGINE), version $(VERSION))"

clean-app:
	rm -rf $(APP)

# Before a push that touches the script engine, the natives or the
# packages: the tests must pass on both engines (ADR 0054).
check: tidy
	cargo nextest run --workspace
	cargo clippy --all-targets
	$(QUICKJS) cargo nextest run --workspace $(QUICKJS_FEATURES)
	$(QUICKJS) cargo clippy --all-targets $(QUICKJS_FEATURES)
	# The web build reaches files through the tree in memory rather than
	# std, which nothing above compiles; checking it here keeps the
	# website's build from being where that is found out (ADR 0066).
	cargo check -q -p e8-script --features e8-core/memory-fs

# Cargo never deletes what a debug build leaves once a build has moved
# on: each change to a crate links its test programs again under a new
# hash, 50 to 130 MB each, beside the old ones, with the workspace's own
# libraries and an incremental cache to match, and every branch adds a
# set. On 2026-11-06 target held 1,752 test programs, 94 GB, and 57 GB of
# incremental caches, 227 GB in all (docs/performance.md). The object
# files matter by count rather than size: macOS's check of a new program
# looks through the folder it is in, so with a million of them every new
# test program waited 45 s to start. Deleting what has not been touched
# for two days (find's -mtime +1) keeps every current program and its
# debug information; the dependencies, which a build rarely touches but
# the next one needs, are never deleted, so a build makes again only what
# it needs of the workspace.
tidy:
	@for profile in target/debug target/quickjs/debug; do \
		deps=$$profile/deps; \
		if [ -d $$deps ]; then \
			before=$$(ls -f $$deps | wc -l); \
			find $$deps -maxdepth 1 -name '*.o' -mtime +1 -delete; \
			find $$deps -maxdepth 1 -type f ! -name '*.*' -mtime +1 -delete; \
			find $$deps -maxdepth 1 \( -name 'libe8_*' -o -name 'libe8-*' \) -mtime +1 -delete; \
			echo "$$deps: $$before files, now $$(ls -f $$deps | wc -l)"; \
		fi; \
		if [ -d $$profile/incremental ]; then \
			find $$profile/incremental -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} +; \
		fi; \
	done
