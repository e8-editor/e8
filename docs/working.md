# How we work

E8 was built in nine days, 27 October to 4 November 2026, in one long Claude Code session: 277 commits on `main`, from a terminal editor to Org mode, Dired, a shell, bidirectional text, images, the editor on its own thread, prompts that return their answer, and ports of the packages an everyday Emacs uses, until E8 could be someone's daily editor. From then on the work is done differently: a session per feature, on a branch of its own, merged by pull request. This page says how, and what the first stretch taught, so that what follows goes better. [CLAUDE.md](../CLAUDE.md) holds the rules every change follows; this is the why and the how.

## A session per feature

- **Each feature or fix has a session, a branch and a worktree of its own**, and ends in a pull request against `main` that Mark merges. The desktop app makes the worktree when a session starts in one; `claude --worktree NAME` does in a terminal. Worktrees live in `.claude/worktrees/`, branched from `origin/main`.
- **A session knows only the repository.** Everything the first session learned that a later one needs is written down here, in CLAUDE.md, in the [ADRs](adr/) and in the docs they point to; a session that learns something a later one would need writes it down too, in the pull request that needed it.
- **A worktree shares the main checkout's build directory** through a `target` symlink that `.claude/hooks/share-target.sh` makes: a target of its own means building V8, egui and tree-sitter again and tens of gigabytes per worktree (the main `target` reached 200 GB). Shared, a worktree's first test build compiles only E8's crates, about a minute. Builds in two worktrees take turns on cargo's lock rather than both running.
- **Each worktree has an app of its own.** `make app` in a worktree builds `E8.app` in the worktree's folder, to open from there, and leaves `target/E8.app`, the app in daily use, to the main checkout. The bundle holds a copy of the binary, so building another branch later does not change it; two worktrees running `make app` at once wait for each other on cargo's lock.
- **Parallel branches meet in a few files.** `packages/e8.d.ts` is generated: after a merge, make it again rather than resolving its conflicts. The GUI snapshots are recorded again and looked at. An ADR's number is the next free on `main`, and the later of two branches that took the same one renumbers. New entries in features.md and differences.md go at the end of their section.
- **Long commands run in the background**: the full test suite, release builds, the fuzzers, the bench, recording oracle cases. Wait for them to finish rather than polling, and say what is happening when it has been quiet for a while.
- **Wait on a file or a process id, never on `pgrep -f` with the command's text**: the waiting loop's own command line holds that text, so it matches itself and never ends. Stop waits that are no longer needed.
- **Each turn ends with a message that stands on its own**: what changed, what was checked and how, what is not done or not verified. It is often read on a phone, hours later, without the transcript.
- **Files are staged by name.** `test.org` and other personal files are never committed.

## The repository is the memory

- **What is only in a conversation is lost**: when it is summarised, and for every other session from the start. So the state lives in the repository: decisions in [ADRs](adr/), plans with their steps in docs ([multithreading.md](multithreading.md), [plan.md](plan.md)), measurements in [performance.md](performance.md), where E8 differs from Emacs in [differences.md](differences.md), ideas for later in [departures.md](departures.md).
- **A plan of several steps gets a doc** with a table of its steps and each one's state, updated as each lands, with what was measured and what was decided. A later session resumes from the doc.
- **CLAUDE.md is read at every turn.** It keeps what every change needs and points to the rest: what E8 does is in [features.md](features.md), what each file holds in [layout.md](layout.md), the decisions in the [ADR index](adr/README.md).

## Personal setups

- **A personal configuration is the user's.** Ask before changing anything in it. A config's packages from the `e8-editor` repositories, installed with `e8.usePackage` and pinned by `e8-lock.json`, take a change once it is tagged and `package-vc-upgrade` is run, or at once by working in that package's checkout.
- **Emacs, as a user has configured it, is the reference for what is expected.** A look that seems to be Emacs's own can come from the configuration, as block faces set in `custom-set-faces` once did: compare with `emacs -Q` before calling something Emacs's behaviour.
- **Personal Org files are private.** Read them only for counts and timings, never print what they hold, and never commit them.
- **What is personal stays out of the repository**, which is public: paths under a home folder, account details, a user's configuration and habits. Sessions keep those in their own memory.

## Behaving like Emacs

- **Ask Emacs rather than guess.** An oracle case in `tests/emacs/cases/` records what GNU Emacs does with some keys, and the tests compare E8 with it. For a quick answer, ask batch Emacs directly, as `emacs -Q --batch --eval '(progn (require (quote org)) (with-temp-buffer (insert "...") (org-mode) (font-lock-ensure) (message "%S" (get-text-property 27 (quote face)))))'` shows which face a character gets. The fuzzers find what nobody thought to test: random documents and keys, recorded in Emacs and compared.
- **Read the Lisp behind the behaviour.** What looked like E8's bugs were often Emacs's own rules, there in the source: marginalia cuts its fields to half the window, vertico truncates its rows past four fifths of the width, `org-fontify-whole-block-delimiter-line` gives a block's #+begin line's newline its face, and the display engine draws an ellipsis over the face of the text it hides.
- **Before changing what a package does, read its issue tracker** (`gh search issues --repo minad/marginalia "width"`). A complaint the maintainer has answered tells whether a behaviour is deliberate; an improvement Emacs's maintainers declined goes in [departures.md](departures.md), not the code, and a deliberate difference made now in [differences.md](differences.md) and `tests/emacs/known-gaps.txt`.
- **Fix the fuzzer's seeds before a change that could alter behaviour.** Note how many differences fixed seeds show before (Org: seeds 7 and 11 at 1,000 cases, 7 and 1 differences on 2026-11-03) and check they are the same after.
- **Port Emacs's Lisp closely**, its names, messages and structure too ([ADR 0013](adr/0013-following-org-closely.md)). Following Org's code is faster than rediscovering its behaviour, and its cache, markers and change hooks turned out to be what E8 needed as well. Reading Emacs, Org and the GPL packages is fine while E8 is GPL; ask before reading the source of anything under another licence ([licensing.md](licensing.md)).

## Looking at the GUI

- **Snapshots first.** A GUI change gets a snapshot in `crates/e8-gui/tests/`; record it with `UPDATE_SNAPSHOTS=1`, then look at the image, enlarged when the change is a pixel or two: a crop scaled up four times showed seams and lines a pixel apart that the full image hid.
- **The snapshots are not in `make check`**, as each process spends a minute getting the GPU from Metal: run `cargo test -p e8-gui --test window --test images` after any change to drawing, and after a change to a shipped package a snapshot shows, such as icomplete or transient. One went stale for a day because only drawing changes were thought to need it.
- **To see the real app**, start `target/E8.app/Contents/MacOS/e8-gui` with `E8_CONFIG_DIR` pointing at a copy of the config and a test file, never a real one, and take a screenshot of its window alone, by id (`screencapture -x -o -l ID`, the id from `CGWindowListCopyWindowInfo`), never the whole screen. Delete the copy's `.e8.desktop.lock` first, or desktop asks whether to use a desktop another E8 holds. Close the app when done: it is open on the user's screen. A second E8 cannot take the agent socket and says so in the echo area; that is harmless.

## Measure before optimising

- **Split the time before choosing the fix.** Profiling the slow keys into interpretation, host calls and primitives ([multithreading.md](multithreading.md), step 0a) is what said to fix Org's heading index before changing engines; the index fix took RET at a heading from 18 to 2.3 ms.
- **Time Emacs on the same file the same way**, as [performance.md](performance.md) does, so "faster than Emacs" is a measurement.
- **The machine is often busy with builds.** Compare like with like, measured under the same load, and note the load when it is high.
- **What made Org slow in QuickJS**: `Object.freeze` on every object, spreading and slicing large arrays, `matchAll` (it compiles its regexp again on every call), and walking every heading where a binary search would do. Update in place and move things lazily, as Org's own element cache does.
- **Try a risky dependency in a spike outside the workspace** first (`spikes/v8`, with an empty `[workspace]`), so nothing in E8 depends on it until it is decided.

## Large mechanical changes

- **Script the change, then let the compiler finish it.** The 402 entries of the binding table were converted by a script, with their result types filled in from the compiler's type errors, and the hundred that did not fit the script by hand.
- **Compare what is generated before and after.** `e8.d.ts` was compared declaration by declaration, ignoring order, which showed the table changed nothing a script sees.
- **Don't edit sources while a test run's build is compiling**: the run then tests a mix of old and new. Wait until its test binaries are listed. A second `cargo build` alongside only waits for the lock.

## Tests on this Mac

- **cargo-nextest**, one test binary per crate, and dependencies optimised in debug builds: the whole suite runs in about half a minute.
- **A test should fail without its fix.** Set the fix aside (a temporary commit, or `git stash push` of just its files in the main checkout, as the stash is shared by every worktree) and run the test once to see it fail.
- **One test is timing-sensitive under load**: `quit::a_script_that_never_checks_is_stopped_and_its_bindings_restored` can fail when the machine is busy, a quit left over landing on its last expression. If it fails alone in a run, run it by itself before suspecting the change.
- **Developer Tools must be on for the app running the builds** (System Settings, Privacy & Security, Developer Tools): Claude.app for a session's builds, Terminal.app for your own.
- **When new test programs are slow to start, count the files in `target/debug/deps`.** macOS's check of a new program looks through its folder, and cargo leaves every debug build's object files there: at a million files each new program waited 45 s. `make tidy` deletes those not touched for two days, and the old test programs, workspace libraries and incremental caches that cargo keeps beside them, which are the size rather than the count: by 2026-11-06 target held 227 GB, 1,752 test programs among them; `make check` runs it first. Worktrees sharing one target make this folder grow faster, and a worktree that built before `share-target.sh` linked it has a target of its own, tens of gigabytes, to delete and link.
- **Run `make check` before pushing**: every test and clippy on V8 and on QuickJS, which builds in `target/quickjs` so switching engines does not rebuild the workspace.
- **Check a fix with a change that makes a new program**: relinking a file that was only touched can give the same binary, which macOS has already let run.

## GitHub

- **When a push fails, look at GitHub's status before the keys**: `curl -s https://www.githubstatus.com/api/v2/status.json`. On 4 November pushes failed for a while during an incident while pulls worked, and nothing local was wrong. Never probe or test SSH private keys.
