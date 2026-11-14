//! Commands that prompt partway through, as Emacs's Lisp reads input
//! where it needs it: the command carries on with the answer, in the
//! context it asked in, and C-g unwinds it. A prompt waits in the command
//! loop, so these drive the editor on a thread of its own (ADR 0053), and
//! still await, which works as before.

use crate::driven::Driven;
use e8_core::Editor;
use e8_script::Scripting;

fn setup(source: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    scripting.eval_typescript(&mut ed, "test.ts", source.to_string()).unwrap();
    (ed, scripting)
}

#[test]
fn an_async_command_carries_on_with_each_answer() {
    let d = Driven::new(
        r#"
        e8.defineCommand({
          name: "greet",
          run: async () => {
            const name = await e8.readString("Name: ");
            const polite = await e8.yOrNP(`Greet ${name} politely? `);
            const place = await e8.completingRead("Where: ", ["home", "work"], { requireMatch: true });
            e8.insert(`${polite ? "Good day" : "Hi"}, ${name}, at ${place}`);
          },
        });
        "#,
    );
    d.mx("greet");
    assert_eq!(d.prompt().as_deref(), Some("Name: "));
    d.type_text("Ada");
    d.press("RET");
    assert_eq!(d.prompt().as_deref(), Some("Greet Ada politely? (y or n) "));
    d.press("y");
    assert_eq!(d.prompt().as_deref(), Some("Where: "));
    d.press("w TAB RET");
    assert_eq!(d.text(), "Good day, Ada, at work");
    assert_eq!(d.prompt(), None);
    // The whole command is what ran last, as in Emacs, where the prompts
    // are read inside it.
    assert_eq!(d.with(|ed| ed.last_command().map(str::to_string)).as_deref(), Some("greet"));
}

#[test]
fn a_prompt_returns_its_answer_without_awaiting() {
    let d = Driven::new(
        r#"
        e8.defineCommand({
          name: "greet",
          run: () => {
            const name = e8.readString("Name: ");
            e8.insert(e8.yOrNP(`Greet ${name}? `) ? `Hi, ${name}` : "");
          },
        });
        "#,
    );
    d.mx("greet");
    d.type_text("Ada\n");
    d.press("y");
    assert_eq!(d.text(), "Hi, Ada");
}

#[test]
fn keys_given_at_once_answer_the_prompt_they_open() {
    // Without a command loop the keys typed ahead answer it, as batch
    // Emacs reads its input; with none left it is the end of input.
    let (mut ed, _s) = setup(r#"e8.defineCommand({ name: "say", run: () => { e8.insert(`[${e8.readString("Say: ")}]`); } });"#);
    ed.press("M-x").unwrap();
    ed.type_text("say\nhi\nz");
    assert_eq!(ed.window_buffer().slice(0..ed.window_buffer().len()), "[hi]z");
    ed.press("M-x").unwrap();
    ed.type_text("say\n");
    assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("Error reading from stdin"));
}

#[test]
fn the_answer_comes_back_to_the_asking_buffer_and_prefix_argument() {
    let d = Driven::new(
        r#"
        e8.defineCommand({
          name: "note-elsewhere",
          run: () => {
            e8.getBufferCreate("notes");
            return e8.withCurrentBuffer("notes", async () => {
              const note = await e8.readString("Note: ");
              e8.insert(`${note} x${e8.prefixNumericValue()}`);
            });
          },
        });
        "#,
    );
    d.press("C-u 3");
    d.mx("note-elsewhere");
    d.type_text("hello");
    d.press("RET");
    let notes = d.with(|ed| ed.buffers().iter().find(|b| b.name == "notes").map(|b| b.slice(0..b.len())));
    assert_eq!(notes.as_deref(), Some("hello x3"));
    // withCurrentBuffer put the buffer back once the command was done.
    assert_eq!(d.text(), "");
    assert!(d.with(|ed| ed.buffer().name == ed.window_buffer().name));
}

#[test]
fn quitting_a_prompt_unwinds_the_command() {
    let d = Driven::new(
        r#"
        e8.defineVariable({ name: "test-bound", doc: "", value: "outside" });
        globalThis.log = [];
        e8.defineCommand({
          name: "ask-and-quit",
          run: () =>
            e8.letBind({ "test-bound": "inside" }, async () => {
              try {
                log.push(`waiting with ${e8.variable("test-bound")}`);
                await e8.readString("Anything: ");
                log.push("answered");
              } catch (e) {
                log.push(`caught ${e8.errorConditions(e).join(" ")}`);
                throw e;
              } finally {
                log.push("cleaned up");
              }
            }),
        });
        "#,
    );
    d.mx("ask-and-quit");
    // While the prompt waits, the binding is in effect, as a let stays
    // bound in a recursive edit.
    assert_eq!(d.eval_expression("e8.variable('test-bound')"), "\"inside\"");
    d.press("C-g");
    assert_eq!(d.prompt(), None);
    assert_eq!(d.message().as_deref(), Some("Quit"));
    // C-g in the minibuffer runs abort-minibuffers, whose quit is
    // minibuffer-quit, a kind of quit, as in Emacs.
    assert_eq!(d.eval_expression("log"), r#"["waiting with inside","caught minibuffer-quit quit","cleaned up"]"#);
    assert_eq!(d.eval_expression("e8.variable('test-bound')"), "\"outside\"");
}

#[test]
fn an_error_after_awaiting_fails_as_the_command_would() {
    let d = Driven::new(
        r#"
        e8.defineCommand({
          name: "fail-later",
          run: async () => {
            const what = await e8.readString("What: ");
            e8.insert("before ");
            e8.userError(`No ${what} here`);
          },
        });
        "#,
    );
    d.mx("fail-later");
    d.type_text("cake");
    d.press("RET");
    let err = d.with(|ed| ed.take_error().map(|e| (e.to_string(), e.is("user-error"))));
    assert_eq!(err, Some(("No cake here".to_string(), true)));
    assert_eq!(d.text(), "before ");
}

#[test]
fn condition_case_catches_what_a_prompt_signals() {
    let d = Driven::new(
        r#"
        globalThis.outcome = "";
        e8.defineCommand({
          name: "careful",
          run: () =>
            e8.conditionCase(async () => {
              await e8.readString("Try: ");
              outcome = "answered";
            }, { quit: () => { outcome = "quit handled"; } }),
        });
        "#,
    );
    d.mx("careful");
    d.press("C-g");
    assert_eq!(d.eval_expression("outcome"), "\"quit handled\"");
}

#[test]
fn a_prompt_inside_the_minibuffer_is_refused_as_emacs_refuses_it() {
    let d = Driven::new(
        r#"
        globalThis.refused = "";
        e8.defineCommand({
          name: "nested",
          run: async () => {
            await e8.readString("Outer: ");
          },
        });
        e8.defineCommand({
          name: "inner",
          run: async () => {
            try {
              await e8.readString("Inner: ");
            } catch (e) {
              refused = (e as Error).message;
            }
          },
        });
        e8.bindKey("C-c i", "inner");
        "#,
    );
    d.mx("nested");
    d.press("C-c i");
    assert_eq!(d.eval_expression("refused"), "\"Command attempted to use minibuffer while in minibuffer\"");
    assert_eq!(d.prompt().as_deref(), Some("Outer: "));
}

#[test]
fn a_macro_replays_a_prompting_command_in_order_with_its_prefix() {
    let d = Driven::new(
        r#"
        e8.defineCommand({
          name: "ask-insert",
          run: async () => {
            const s = await e8.readString("Say: ");
            e8.insert(`[${s}:${e8.prefixNumericValue()}]`);
          },
        });
        "#,
    );
    d.press("<f3> C-u");
    d.mx("ask-insert");
    d.type_text("foo");
    d.press("RET z <f4>");
    assert_eq!(d.text(), "[foo:4]z");
    d.press("C-x e");
    assert_eq!(d.text(), "[foo:4]z[foo:4]z");
}

#[test]
fn answering_by_key_leaves_no_command_context_behind() {
    let d = Driven::new(
        r#"
        e8.defineCommand({
          name: "ask-yn",
          run: async () => {
            if (await e8.yOrNP("Sure? ")) e8.insert(`yes ${e8.prefixNumericValue()}`);
          },
        });
        "#,
    );
    d.press("C-u 7");
    d.mx("ask-yn");
    d.press("y");
    assert_eq!(d.text(), "yes 7");
    let (prefix, this, last) = d.with(|ed| {
        (ed.current_prefix_arg().is_none(), ed.this_command().map(str::to_string), ed.last_command().map(str::to_string))
    });
    assert!(prefix);
    assert_eq!(this, None);
    assert_eq!(last.as_deref(), Some("ask-yn"));
}

#[test]
fn timers_run_while_a_prompt_waits() {
    let (mut ed, _s) = setup(
        r#"
        e8.getBufferCreate("log");
        e8.runWithTimer(1, 1, () => e8.withCurrentBuffer("log", () => e8.insert("tick ")));
        "#,
    );
    ed.press("M-x").unwrap();
    ed.type_text("fo");
    ed.advance_clock(std::time::Duration::from_millis(1500));
    ed.advance_clock(std::time::Duration::from_millis(1000));
    assert_eq!(ed.minibuffer_input(), "fo");
    let log = ed.buffers().iter().find(|b| b.name == "log").unwrap();
    assert_eq!(log.slice(0..log.len()), "tick tick ");
}

#[test]
fn the_sample_config_loads_and_its_prompting_command_works() {
    let d = Driven::new("");
    d.load_file(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/init.ts"));
    d.press("C-u 2 C-c n");
    assert_eq!(d.prompt().as_deref(), Some("Note 1 of 2: "));
    d.type_text("one");
    d.press("RET");
    d.type_text("two");
    d.press("RET");
    d.press("y");
    assert_eq!(d.buffer_name(), "*notes*");
    let notes = d.text();
    assert!(notes.ends_with(" one\n") || notes.contains(" one\n"), "{notes}");
    assert!(notes.ends_with(" two\n"), "{notes}");
}

#[test]
fn a_completion_table_can_be_a_function_of_the_input() {
    let d = Driven::new(
        r#"
        globalThis.asked = [];
        e8.defineCommand({
          name: "pick-path",
          run: async () => {
            // Names under the directory typed so far, as a completion-table-dynamic's function gives them.
            const p = await e8.completingRead("Path: ", (input: string) => {
              asked.push(input);
              const dir = input.slice(0, input.lastIndexOf("/") + 1);
              return [`${dir}apple`, `${dir}banana`, `${dir}cherry/`];
            }, { requireMatch: true });
            e8.insert(p);
          },
        });
        "#,
    );
    d.mx("pick-path");
    d.type_text("c");
    d.press("TAB");
    assert_eq!(d.minibuffer_input(), "cherry/");
    d.type_text("b");
    d.press("TAB RET");
    assert_eq!(d.text(), "cherry/banana");
    let asked = d.eval_expression("asked");
    assert!(asked.contains(r#""cherry/b""#), "{asked}");
}

#[test]
fn a_dynamic_table_keeps_icompletes_rotation() {
    let d = Driven::new(
        r#"
        e8.defineCommand({
          name: "pick-fruit",
          run: async () => { e8.insert(await e8.completingRead("Fruit: ", () => ["apple", "apricot", "avocado"])); },
        });
        "#,
    );
    d.mx("pick-fruit");
    d.press("a");
    let shown = || d.with(|ed| ed.minibuffer_strings().1);
    let before = shown();
    d.press("C-.");
    assert_ne!(shown(), before, "C-. rotates the completions");
    // As icomplete-force-complete-and-exit takes the first of them.
    d.press("C-j");
    assert_eq!(d.text(), "apricot");
}
