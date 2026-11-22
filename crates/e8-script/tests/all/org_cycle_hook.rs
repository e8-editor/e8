//! org-cycle-hook: what it is given, and C-c C-x b running it in the
//! indirect buffer, which the Emacs oracle does not show, its case ending
//! in the buffer it started in.

use e8_core::Editor;
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, source: &str) {
    s.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

/// A function on the hook is given each state TAB and S-TAB set, after
/// Org's own, and one on org-cycle-pre-hook the state about to be set.
#[test]
fn the_hooks_are_given_the_states() {
    let (mut ed, s) = org("* A\n** a\ntext\n* B\n");
    eval(
        &mut ed,
        &s,
        r#"
        globalThis.seen = [];
        e8.addHook("org-cycle-pre-hook", (state: string) => { globalThis.seen.push(`pre ${state}`); });
        e8.addHook("org-cycle-hook", (state: string) => { globalThis.seen.push(state); }, { append: true });
        e8.defineCommand({ name: "test-seen", run: () => e8.message(globalThis.seen.join(",")) });
        "#,
    );
    ed.press("TAB TAB TAB S-<tab>").unwrap();
    ed.call("test-seen", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("pre folded,folded,pre children,children,pre subtree,subtree,pre overview,overview"));
}

/// C-c C-x b runs org-cycle-hook with all in the indirect buffer, so an
/// archived subtree there stays closed, and a frame of its own is titled
/// after the heading.
#[test]
fn the_indirect_buffer_runs_the_hook_and_titles_its_frame() {
    let (mut ed, s) = org("* TODO P\n** A :ARCHIVE:\nhidden text\n** B\nshown\n");
    eval(
        &mut ed,
        &s,
        r#"
        e8.setDefault("org-indirect-buffer-display", "new-frame");
        globalThis.states = [];
        e8.addHook("org-cycle-hook", (state: string) => { globalThis.states.push(`${state} in ${e8.bufferName()}`); }, { append: true });
        e8.defineCommand({ name: "test-look", run: () => {
          const b = e8.bufferList().find((x) => x.includes("::"))!;
          const text = e8.withCurrentBuffer(b, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()));
          const shown = e8.withCurrentBuffer(b, () => [...Array(e8.pointMax()).keys()].filter((i) => !e8.invisibleAt(i)).map((i) => text[i] ?? "").join(""));
          e8.message(`${globalThis.states.join(",")} | ${e8.frameParameter(undefined, "name")} | ${JSON.stringify(shown)}`);
        } });
        "#,
    );
    ed.press("C-c C-x b").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    ed.call("test-look", vec![]).unwrap();
    let echo = ed.echo().unwrap_or_default().to_string();
    assert!(echo.contains("::TODO P | TODO P | "), "{echo}");
    assert!(echo.starts_with("all in "), "{echo}");
    assert!(!echo.contains("hidden text"), "{echo}");
    assert!(echo.contains("shown"), "{echo}");
}
