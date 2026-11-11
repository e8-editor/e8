//! Windows and frames as objects, as Emacs's window and frame objects are
//! (ADR 0069): the same object each time, a window still once deleted
//! though no longer live, printed as Emacs prints them, and never taken for
//! one another. Numbers are taken too while packages move to the objects.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn a_deleted_window_is_still_a_window_but_not_live() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.w1 = e8.selectedWindow(), globalThis.w2 = e8.splitWindow(), e8.deleteWindow(w2),
          JSON.stringify([e8.windowp(w2), e8.windowLiveP(w2), e8.windowValidP(w2), w2.live, w1.live,
            e8.windowp(1), e8.windowp(e8.selectedFrame()), e8.framep(e8.selectedFrame()), e8.framep(w1),
            e8.frameLiveP(e8.selectedFrame()), e8.windowList()[0] === w1, e8.selectedWindow() === w1]))"#,
    );
    // Emacs: (t nil nil nil t nil t ...): windowp is true of a deleted window and false of a number
    assert_eq!(got, "[true,false,false,false,true,false,false,true,false,true,true,true]");
}

#[test]
fn windows_and_frames_print_as_emacs_prints_them_and_never_share_a_number() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([String(e8.selectedWindow()), String(e8.selectedFrame()), String(e8.minibufferWindow()),
          e8.selectedWindow().id !== e8.selectedFrame().id, e8.windowLiveP(e8.selectedFrame().id), e8.frameLiveP(e8.selectedWindow().id)])"#,
    );
    // Emacs: #<window 1 on *scratch*>, #<frame F1 ...>
    assert_eq!(got, r##"["#<window 1 on *scratch*>","#<frame F1>","#<window 0 on  *Minibuf-1*>",true,false,false]"##);
}

#[test]
fn numbers_are_still_taken_and_objects_come_back() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.w2 = e8.splitWindow(1), JSON.stringify([e8.windowBuffer(w2.id), e8.windowLiveP(w2.id), e8.windowFrame(1) === e8.selectedFrame(),
          e8.conditionCase(() => e8.windowBuffer("not a window"), { error: () => "refused" })]))"#,
    );
    assert_eq!(got, r#"["*scratch*",true,true,"refused"]"#);
}

#[test]
fn windows_and_frames_keep_their_identity_through_variables_and_parameters() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.w2 = e8.splitWindow(), e8.setVariable("test-window", w2), e8.setVariable("test-frame", e8.selectedFrame()),
          e8.setWindowParameter(undefined, "partner", w2),
          JSON.stringify([e8.variable("test-window") === w2, e8.variable("test-frame") === e8.selectedFrame(),
            e8.windowParameter(undefined, "partner") === w2, e8.windowp(e8.variable("test-window")),
            (() => { const tree = e8.windowTree(); return Array.isArray(tree) && tree[2] === e8.selectedWindow() && tree[3] === w2; })(),
            e8.posnAtPoint(0)?.window === e8.selectedWindow()]))"#,
    );
    assert_eq!(got, "[true,true,true,true,true,true]");
}
