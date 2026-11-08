//! M-x agent-shell: a coding agent over ACP in an Org buffer, here a fake
//! that plays a script (tests/data/fake_acp_agent.py). A reply streams in,
//! tool calls show and fold, permission is asked of the user and only of
//! the user, files are read and written through their buffers, C-c C-k
//! stops a turn, and an agent that fails or needs a login says so. The
//! editor runs on a driver, as the agent's questions come from a timer.

use std::path::Path;

use serde_json::{Value, json};

use crate::driven::Driven;

struct Shell {
    d: Driven,
    dir: tempfile::TempDir,
}

fn python() -> Option<&'static str> {
    ["python3", "/usr/bin/python3"].into_iter().find(|p| std::process::Command::new(p).arg("-V").output().is_ok())
}

/// The first steps of every conversation: initialize, a session, and the prompt.
fn opening(prompt: &str) -> Vec<Value> {
    vec![
        json!({"expect": {"method": "initialize", "id": 1, "params": {"protocolVersion": 1, "clientInfo": {"name": "e8"},
            "clientCapabilities": {"fs": {"readTextFile": true, "writeTextFile": true}}}}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}}}),
        json!({"expect": {"method": "session/new", "id": 2, "params": {"mcpServers": []}}}),
        json!({"send": {"id": 2, "result": {"sessionId": "s1"}}}),
        json!({"expect": {"method": "session/prompt", "id": 3, "params": {"sessionId": "s1", "prompt": [{"type": "text", "text": prompt}]}}}),
    ]
}

fn update(update: Value) -> Value {
    json!({"send": {"method": "session/update", "params": {"sessionId": "s1", "update": update}}})
}

fn chunk(text: &str) -> Value {
    update(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}))
}

fn end_turn(reason: &str) -> Value {
    json!({"send": {"id": 3, "result": {"stopReason": reason}}})
}

fn permission(id: u64, title: &str) -> Value {
    json!({"send": {"id": id, "method": "session/request_permission", "params": {
        "sessionId": "s1",
        "toolCall": {"toolCallId": "t1", "title": title, "kind": "edit", "status": "pending"},
        "options": [
            {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
            {"optionId": "always", "name": "Always Allow", "kind": "allow_always"},
            {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
        ],
    }}})
}

/// An editor with the fake as the agent `fake`, playing `steps`, its shell
/// open in another window and the request typed under * You.
fn setup(steps: Vec<Value>, request: &str) -> Option<Shell> {
    setup_with(steps, request, "")
}

/// As [`setup`], running `source` first.
fn setup_with(steps: Vec<Value>, request: &str, source: &str) -> Option<Shell> {
    let s = open(vec![steps], source)?;
    s.d.type_text(request);
    Some(s)
}

/// An editor with the fake as the agent `fake`, its shell just opened: the
/// fake plays the first script, and the next when it is started again.
fn open(scripts: Vec<Vec<Value>>, source: &str) -> Option<Shell> {
    let python = python()?;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let mut command = vec![json!(python), json!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/fake_acp_agent.py"))];
    for (i, steps) in scripts.into_iter().enumerate() {
        let script = dir.path().join(format!("script{i}.json"));
        std::fs::write(&script, Value::Array(steps).to_string()).unwrap();
        command.push(json!(script.display().to_string()));
    }
    let log = dir.path().join("received.jsonl");
    let d = Driven::new(&format!(
        r#"e8.setVariable("agent-shell-agents", [["fake", {}, [{}]]]);
        e8.setVariable("agent-shell-default-agent", "fake");
        {}"#,
        Value::Array(command),
        json!(format!("FAKE_ACP_LOG={}", log.display())),
        source,
    ));
    d.mx("agent-shell");
    assert_eq!(d.buffer_name(), "*agent-shell: fake*");
    assert_eq!(d.text(), "* You\n");
    Some(Shell { d, dir })
}

impl Shell {
    fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("received.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// Waits until the turn has ended, with a heading for the next request.
    fn finished(&self) -> String {
        self.d.until(|t| t.matches("* You\n").count() == 2);
        self.d.text()
    }

    /// The question the user is being asked, by the echo area or a prompt.
    fn asked(&self) -> Option<String> {
        self.d.prompt().or_else(|| self.d.message()).filter(|q| q.starts_with("Let "))
    }

    fn wait_asked(&self) -> String {
        let start = std::time::Instant::now();
        loop {
            if let Some(q) = self.asked() {
                return q;
            }
            assert!(start.elapsed() < std::time::Duration::from_secs(10), "never asked: {:?}", self.d.text());
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

}

/// A JavaScript expression's value, a string.
fn js_string(d: &Driven, expression: &str) -> String {
    let value = d.eval_expression(expression);
    serde_json::from_str::<String>(&value).unwrap_or(value)
}

fn shown(path: &Path) -> String {
    path.display().to_string()
}

#[test]
fn a_reply_streams_in_with_its_thinking_tool_calls_and_plan() {
    let mut steps = opening("fix it");
    steps.extend([
        update(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Looking at\nthe file"}})),
        chunk("I'll fix it.\n* not a heading\n"),
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit `a.txt`", "kind": "edit", "status": "pending"})),
        update(json!({"sessionUpdate": "plan", "entries": [
            {"content": "Read a.txt", "priority": "high", "status": "completed"},
            {"content": "Change two", "priority": "high", "status": "in_progress"},
        ]})),
        update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
            "content": [{"type": "diff", "path": "/x/a.txt", "oldText": "one\ntwo\nthree", "newText": "one\n2\nthree"}]})),
        update(json!({"sessionUpdate": "plan", "entries": [
            {"content": "Read a.txt", "priority": "high", "status": "completed"},
            {"content": "Change two", "priority": "high", "status": "completed"},
        ]})),
        chunk("Done."),
        update(json!({"sessionUpdate": "usage_update", "used": 1200, "size": 200000})),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "fix it") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert_eq!(
        text,
        "* You\nfix it\n\n* Agent\n#+begin_thinking\nLooking at\nthe file\n#+end_thinking\n\
         I'll fix it.\n- not a heading\n\
         → ~Edit a.txt~\n#+begin_src diff\n--- /x/a.txt\n+++ /x/a.txt\n@@ line 2 @@\n-two\n+2\n#+end_src\n\
         Plan:\n- [X] Read a.txt\n- [X] Change two\n\
         Done.\n\n* You\n"
    );
    // The diff folds into its tool call's line, from the line's end; the
    // thinking folds as any Org block, after its #+begin_thinking line; the reply does not.
    let tool = text.find("→ ~Edit a.txt~").unwrap();
    let tool_end = text[tool..].find('\n').unwrap() + tool;
    assert!(!hidden_in(&s.d, &text, tool), "the tool call's line shows");
    assert!(hidden_in(&s.d, &text, tool_end), "its diff folds into it, #+begin_src and all");
    assert!(hidden_in(&s.d, &text, text.find("--- /x/a.txt").unwrap()));
    let thinking = text.find("#+begin_thinking").unwrap();
    assert!(!hidden_in(&s.d, &text, thinking), "the block's first line shows");
    assert!(hidden_in(&s.d, &text, text.find("Looking at").unwrap()), "its text folds");
    assert!(!hidden_in(&s.d, &text, text.find("Done.").unwrap()), "the reply shows");
    // TAB on the tool call's line shows its diff, and folds it again; on the block's first line it is Org's own.
    s.d.eval(&format!("e8.gotoChar({})", tool + 2));
    s.d.press("TAB");
    assert!(!hidden_in(&s.d, &text, tool_end), "TAB shows the diff");
    s.d.press("TAB");
    assert!(hidden_in(&s.d, &text, tool_end), "TAB folds it again");
    s.d.eval(&format!("e8.gotoChar({thinking})"));
    s.d.press("TAB");
    assert!(!hidden_in(&s.d, &text, text.find("Looking at").unwrap()), "TAB opens the thinking");
    // How much of its context the conversation fills shows on the mode line, not in the conversation.
    assert_eq!(js_string(&s.d, "e8.variable(\"mode-line-process\")"), " 1k/200k");
    assert!(js_string(&s.d, "e8.variable(\"header-line-format\")").contains("C-c RET"));
}

#[test]
fn the_agents_markdown_becomes_org_however_it_is_cut_into_chunks() {
    let mut steps = opening("explain");
    steps.extend([
        chunk("Here is **bo"),
        chunk("ld** and `co"),
        chunk("de`\n## What chan"),
        chunk("ged\n* one\n* two with [a link](https://e8.dev/a_b)\n```sh\n* not a heading\nls\n``"),
        chunk("`\nThe end, "),
        chunk("~~struck~~"),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "explain") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert_eq!(
        text,
        "* You\nexplain\n\n* Agent\n\
         Here is *bold* and ~code~\n*What changed*\n- one\n- two with [[https://e8.dev/a_b][a link]]\n\
         #+begin_src sh\n,* not a heading\nls\n#+end_src\nThe end, +struck+\n\n* You\n"
    );
}

#[test]
fn markdown_lines_become_org() {
    let d = Driven::new(
        r#"import("agent-shell").then((m: any) => {
          (globalThis as any).toOrg = (text: string) => { const state = {}; return text.split("\n").map((l) => m.markdownLineToOrg(l, state)).join("\n"); };
        });"#,
    );
    let cases = [
        ("Some **bold**, *italic*, _also_ and `code`.", "Some *bold*, /italic/, /also/ and ~code~."),
        ("snake_case_name, a * b * c, 2*3*4", "snake_case_name, a * b * c, 2*3*4"),
        ("__strong__ and ~~gone~~", "*strong* and +gone+"),
        ("`a~b` and `a~b=c` and `**not bold**`", "=a~b= and `a~b=c` and ~**not bold**~"),
        ("# Title", "*Title*"),
        ("### **Bold** heading ###", "*Bold heading*"),
        ("* item\n  + nested\n1. first", "- item\n  - nested\n1. first"),
        ("See [the docs](https://x.org/a_b_c \"t\"), ![img](p.png) and <https://y.org>.", "See [[https://x.org/a_b_c][the docs]], [[p.png]] and [[https://y.org]]."),
        ("---\n***", "-----\n-----"),
        ("| a | b |\n|---|:-:|\n| 1 | 2 |", "| a | b |\n|---+---|\n| 1 | 2 |"),
        ("```rust\n* x\n#+end_src\n````\n```", "#+begin_src rust\n,* x\n,#+end_src\n#+end_src\n#+begin_example"),
        ("```\nplain\n```", "#+begin_example\nplain\n#+end_example"),
        ("  ```py\n  x = 1\n  ```", "  #+begin_src py\n  x = 1\n  #+end_src"),
        ("#+TITLE: not a keyword\n** not a heading", " #+TITLE: not a keyword\n ** not a heading"),
    ];
    for (markdown, org) in cases {
        let got = js_string(&d, &format!("toOrg({})", json!(markdown)));
        assert_eq!(got, org, "{markdown:?}");
    }
}

#[test]
fn the_agent_asks_and_the_user_allows() {
    let mut steps = opening("edit");
    steps.extend([
        permission(50, "Edit `a.txt`"),
        json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}}}),
        update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"})),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "edit") else { return };
    s.d.press("C-c RET");
    assert_eq!(s.wait_asked(), "Let fake edit a.txt? (y, ! for always or n) ");
    s.d.press("y");
    let text = s.finished();
    assert!(text.contains("→ ~Edit a.txt~\n[Allow: Edit `a.txt`]\n"), "{text}");
}

#[test]
fn the_user_can_refuse_or_allow_always() {
    for (key, option, name) in [("n", "reject", "Reject"), ("!", "always", "Always Allow")] {
        let mut steps = opening("edit");
        steps.extend([
            permission(50, "Edit `a.txt`"),
            json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "selected", "optionId": option}}}}),
            end_turn("end_turn"),
        ]);
        let Some(s) = setup(steps, "edit") else { return };
        s.d.press("C-c RET");
        s.wait_asked();
        s.d.press(key);
        let text = s.finished();
        assert!(text.contains(&format!("[{name}: Edit `a.txt`]")), "{text}");
    }
}

#[test]
fn the_question_waits_while_the_user_has_one_of_their_own_open() {
    let mut steps = opening("edit");
    steps.extend([
        json!({"sleep": 0.5}),
        permission(50, "Edit `a.txt`"),
        json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}}}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "edit") else { return };
    s.d.press("C-c RET");
    // The user opens a prompt of their own before the agent asks.
    s.d.press("M-x");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(s.d.prompt().as_deref(), Some("M-x "), "the agent's question waits");
    assert!(s.received().iter().all(|m| m["id"] != json!(50)), "and nothing answered it");
    // Once the user's is closed, the agent's is asked.
    s.d.press("C-g");
    s.wait_asked();
    s.d.press("y");
    s.finished();
}

#[test]
fn files_are_read_through_their_buffers_unsaved_text_and_all() {
    let Some(python) = python() else { return };
    let _ = python;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let visited = dir.path().join("visited.txt");
    let other = dir.path().join("other.txt");
    std::fs::write(&visited, "saved\n").unwrap();
    std::fs::write(&other, "1\n2\n3\n4\n").unwrap();
    let mut steps = opening("read");
    steps.extend([
        json!({"send": {"id": 60, "method": "fs/read_text_file", "params": {"sessionId": "s1", "path": shown(&visited)}}}),
        json!({"expect": {"id": 60, "result": {"content": "unsaved\n"}}}),
        json!({"send": {"id": 61, "method": "fs/read_text_file", "params": {"sessionId": "s1", "path": shown(&other), "line": 2, "limit": 2}}}),
        json!({"expect": {"id": 61, "result": {"content": "2\n3"}}}),
        json!({"send": {"id": 62, "method": "fs/read_text_file", "params": {"sessionId": "s1", "path": shown(&dir.path().join("missing"))}}}),
        json!({"expect": {"id": 62, "error": {"code": -32603}}}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "read") else { return };
    // The file is visited and changed, not saved.
    let path = shown(&visited);
    s.d.with(move |ed| {
        ed.call("find-file-other-window", vec![e8_core::Arg::Str(path)]).unwrap();
        ed.press("M-< C-k").unwrap();
        ed.type_text("unsaved");
        ed.press("C-x o").unwrap();
    });
    assert_eq!(s.d.buffer_name(), "*agent-shell: fake*");
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(!text.contains("Error"), "{text}");
    drop(dir);
}

#[test]
fn files_are_written_through_their_buffers_and_saved() {
    let mut steps = opening("write");
    let Some(python) = python() else { return };
    let _ = python;
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let visited = dir.path().join("a.txt");
    std::fs::write(&visited, "one\ntwo\nthree\n").unwrap();
    let fresh = dir.path().join("new/dir/b.txt");
    steps.extend([
        json!({"send": {"id": 70, "method": "fs/write_text_file", "params": {"sessionId": "s1", "path": shown(&visited), "content": "one\n2\nthree\n"}}}),
        json!({"expect": {"id": 70, "result": null}}),
        json!({"send": {"id": 71, "method": "fs/write_text_file", "params": {"sessionId": "s1", "path": shown(&fresh), "content": "made\n"}}}),
        json!({"expect": {"id": 71, "result": null}}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "write") else { return };
    let path = shown(&visited);
    s.d.with(move |ed| {
        ed.call("find-file-other-window", vec![e8_core::Arg::Str(path)]).unwrap();
        // Point on the last line, which the edit leaves alone.
        ed.press("M-> C-p C-f").unwrap();
        ed.press("C-x o").unwrap();
    });
    s.d.press("C-c RET");
    s.finished();
    assert_eq!(std::fs::read_to_string(&visited).unwrap(), "one\n2\nthree\n");
    assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "made\n");
    let (text, point, modified) = s.d.with(|ed| {
        let b = &ed.buffers()[ed.find_buffer("a.txt").unwrap()];
        (b.slice(0..b.len()), b.point(), b.is_modified())
    });
    assert_eq!(text, "one\n2\nthree\n");
    assert_eq!(point, 7, "point stays at its line and column");
    assert!(!modified, "saved");
    // The write was an edit in the buffer, which undoes.
    s.d.with(|ed| {
        ed.press("C-x o").unwrap();
        ed.press("C-/").unwrap();
    });
    assert_eq!(s.d.text(), "one\ntwo\nthree\n");
    drop(dir);
}

#[test]
fn a_file_the_agent_wrote_itself_is_reverted_unless_it_has_unsaved_edits() {
    let Some(_) = python() else { return };
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let clean = dir.path().join("clean.txt");
    let edited = dir.path().join("edited.txt");
    std::fs::write(&clean, "old\n").unwrap();
    std::fs::write(&edited, "old\n").unwrap();
    let mut steps = opening("edit");
    steps.extend([
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Write", "kind": "edit", "status": "in_progress",
            "locations": [{"path": shown(&clean)}, {"path": shown(&edited)}]})),
        // Its own tool writes both files, as Claude Code's does.
        json!({"sleep": 1.1}),
        json!({"write": [shown(&clean), "new\n"]}),
        json!({"write": [shown(&edited), "new\n"]}),
        update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"})),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "edit") else { return };
    let (a, b) = (shown(&clean), shown(&edited));
    s.d.with(move |ed| {
        ed.call("find-file-other-window", vec![e8_core::Arg::Str(a)]).unwrap();
        ed.call("find-file", vec![e8_core::Arg::Str(b)]).unwrap();
        ed.type_text("mine ");
        ed.press("C-x o").unwrap();
    });
    s.d.press("C-c RET");
    s.finished();
    let texts = s.d.with(|ed| {
        let text = |name: &str| {
            let b = &ed.buffers()[ed.find_buffer(name).unwrap()];
            (b.slice(0..b.len()), b.is_modified())
        };
        (text("clean.txt"), text("edited.txt"))
    });
    assert_eq!(texts.0, ("new\n".to_string(), false), "reverted to what the agent wrote");
    assert_eq!(texts.1, ("mine old\n".to_string(), true), "the user's edits are kept");
    drop(dir);
}

#[test]
fn c_c_c_k_stops_the_turn() {
    let mut steps = opening("go");
    steps.extend([
        chunk("Working"),
        permission(50, "Run `make`"),
        json!({"expect": {"id": 50, "result": {"outcome": {"outcome": "cancelled"}}}}),
        json!({"expect": {"method": "session/cancel", "params": {"sessionId": "s1"}}}),
        end_turn("cancelled"),
    ]);
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    s.wait_asked();
    // C-g leaves the question, answering it as cancelled; C-c C-k then stops the turn.
    s.d.press("C-g");
    s.d.until(|t| t.contains("[Cancelled: Run `make`]"));
    s.d.press("C-c C-k");
    let text = s.finished();
    assert!(text.ends_with("[Cancelled: Run `make`]\n[Stopped.]\n\n* You\n"), "{text}");
}

#[test]
fn c_c_c_k_tells_the_agent_to_cancel() {
    let mut steps = opening("go");
    steps.extend([
        chunk("Working"),
        json!({"expect": {"method": "session/cancel", "params": {"sessionId": "s1"}}}),
        end_turn("cancelled"),
    ]);
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("Working"));
    assert_eq!(js_string(&s.d, "e8.variable(\"mode-line-process\")"), ":working", "the mode line says the agent is working");
    s.d.press("C-c C-k");
    let text = s.finished();
    assert!(text.ends_with("Working\n[Stopped.]\n\n* You\n"), "{text}");
}

#[test]
fn an_agent_that_stops_says_why_and_the_next_request_starts_it_again() {
    let mut steps = opening("go");
    steps.extend([json!({"stderr": "something broke\n"}), json!({"sleep": 0.3}), json!({"exit": 1})]);
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(
        text.contains("[Error: Agent process ended before completing request: exited abnormally with code 1\nsomething broke]"),
        "{text}"
    );
    // The buffer takes the next request: the fake, started again, plays its script anew.
    s.d.press("M->");
    s.d.type_text("go");
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("[Starting fake again, in a new session.]"));
}

#[test]
fn an_agent_that_needs_a_login_says_so() {
    let steps = vec![
        json!({"expect": {"method": "initialize"}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "authMethods": [{"id": "claude-login", "name": "Log in"}]}}}),
        json!({"expect": {"method": "session/new"}}),
        json!({"send": {"id": 2, "error": {"code": -32000, "message": "Authentication required"}}}),
    ];
    let Some(s) = setup(steps, "hi") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(text.contains("[Error: fake needs you to log in: log in with "), "{text}");
}

#[test]
fn an_agent_that_is_not_installed_says_so() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["no-such-claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("agent-shell-session-strategy", "new");"#,
    );
    d.mx("agent-shell");
    d.type_text("hi");
    d.press("C-c RET");
    d.until(|t| t.matches("* You\n").count() == 2);
    assert!(d.text().contains("[Error: \"no-such-claude-agent-acp\" command line utility not found."), "{}", d.text());
}

#[test]
fn killing_the_buffer_stops_the_agent() {
    let mut steps = opening("go");
    steps.push(chunk("Working"));
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("Working"));
    let running = || s.d.with(|ed| ed.process_list().iter().any(|p| p.starts_with("acp-client")));
    assert!(running());
    s.d.with(|ed| {
        ed.call("kill-buffer", vec![e8_core::Arg::Str("*agent-shell: fake*".into())]).unwrap();
    });
    let start = std::time::Instant::now();
    while running() {
        assert!(start.elapsed() < std::time::Duration::from_secs(10), "the agent still runs");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// The real Claude Code, through claude-agent-acp from npm, when this
/// machine has Node and a Claude login: `cargo test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_answers() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("agent-shell-session-strategy", "new");"#,
    );
    d.mx("agent-shell");
    d.type_text("Reply with just the word pong, and use no tools.");
    d.press("C-c RET");
    let start = std::time::Instant::now();
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let text = d.text();
    eprintln!("{text}");
    let reply = &text[text.find("* Agent\n").unwrap()..];
    assert!(reply.to_lowercase().contains("pong") && !reply.contains("[Error"), "{text}");
}

/// The real Claude Code answering in Markdown, which the buffer shows as
/// Org: `cargo test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_s_markdown_becomes_org() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("agent-shell-session-strategy", "new");"#,
    );
    d.mx("agent-shell");
    d.type_text(
        "Use no tools. Reply in Markdown with a ## heading, a sentence with **bold** and `inline code`, \
         a bulleted list using * bullets, and a ```sh fenced block holding: ls -la | grep -E '^d+'",
    );
    d.press("C-c RET");
    let start = std::time::Instant::now();
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let text = d.text();
    eprintln!("{text}");
    let reply = &text[text.find("* Agent\n").unwrap()..text.rfind("\n* You\n").unwrap()];
    assert!(reply.contains("#+begin_src sh") && reply.contains("#+end_src"), "{text}");
    assert!(!reply.contains("```") && !reply.contains("**") && !reply.contains("\n## ") && !reply.contains("\n* "), "{text}");
}

/// The real Claude Code's settings: its session starts with the buffer,
/// and the model picked before the first request is the one that answers:
/// `cargo test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_s_model_is_picked_before_the_first_request() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("agent-shell-session-strategy", "new");"#,
    );
    d.mx("agent-shell");
    let start = std::time::Instant::now();
    // The settings show ahead of the keys once the session is there.
    while header(&d).starts_with(" Starting") || header(&d).starts_with(" C-c RET") {
        assert!(start.elapsed() < std::time::Duration::from_secs(120), "{}", header(&d));
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("{}", header(&d));
    d.eval(r#"e8.call("agent-shell-set-session-model", "haiku")"#);
    while !header(&d).starts_with(" Haiku") {
        assert!(start.elapsed() < std::time::Duration::from_secs(120), "{}", header(&d));
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("{}", header(&d));
    d.type_text("Which Claude model are you? Answer with just its name, and use no tools.");
    d.press("C-c RET");
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let text = d.text();
    eprintln!("{text}");
    let reply = &text[text.find("* Agent\n").unwrap()..];
    assert!(reply.to_lowercase().contains("haiku"), "{text}");
}

/// The real Claude Code's tool calls: short lines with what they did,
/// their output folded as it comes, and its bookkeeping left out: `cargo
/// test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_s_tool_calls_fold_as_they_come() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("agent-shell-session-strategy", "new");"#,
    );
    d.mx("agent-shell");
    d.type_text("Run `ls crates` with your Bash tool, then read Cargo.toml's first five lines with your Read tool, then reply in one short sentence.");
    d.press("C-c RET");
    let start = std::time::Instant::now();
    // Once the first output is in, and before the turn ends, it is folded.
    let mut seen_folded = false;
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        let t = d.text();
        if let Some(i) = t.find("#+begin_src ") {
            if t.matches("* You\n").count() < 2 && hidden_in(&d, &t, i) {
                seen_folded = true;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let text = d.text();
    eprintln!("{text}");
    let reply = &text[text.find("* Agent\n").unwrap()..];
    assert!(reply.contains("→ ~ls crates~"), "{text}");
    assert!(!reply.contains("ToolSearch"), "{text}");
    assert!(seen_folded, "a block was folded while the turn went on");
}

/// The real Claude Code writing a file, answering yes if it asks: `cargo
/// test -- --ignored live`. Its adapter writes with its own tools, asking
/// as Claude Code's permission settings say, rather than through the
/// editor's fs/write_text_file; the traffic it printed shows which.
/// The real Claude Code's slash commands completing at the prompt, nothing
/// sent: `cargo test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_s_slash_commands_complete() {
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("agent-shell-session-strategy", "new");"#,
    );
    d.mx("agent-shell");
    d.type_text("/conte");
    let capf = r#"JSON.stringify(e8.runHookWithArgsUntilSuccess("completion-at-point-functions") ?? null)"#;
    let start = std::time::Instant::now();
    while d.eval_expression(capf) == json!("null").to_string() {
        assert!(start.elapsed() < std::time::Duration::from_secs(120), "no commands: {}", d.text());
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    d.press("TAB");
    eprintln!("{}\n{:?}", d.text(), d.message());
    assert!(d.text().ends_with("* You\n/context"), "{}", d.text());
    assert!(d.message().is_some_and(|m| m.starts_with("/context: ")), "{:?}", d.message());
}

/// The real Claude Code resuming a session another editor had, and
/// remembering what was said in it: `cargo test -- --ignored live`.
#[test]
#[ignore]
fn live_claude_code_resumes_a_session_and_remembers_it() {
    let dir = tempfile::tempdir().unwrap();
    let dir_name = std::fs::canonicalize(dir.path()).unwrap().display().to_string();
    std::fs::write(dir.path().join("notes.txt"), "notes\n").unwrap();
    let editor = |strategy: &str| {
        let d = Driven::new(&format!(
            r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
            e8.setVariable("agent-shell-default-agent", "claude");
            e8.setVariable("agent-shell-e8-tools", false);
            e8.setVariable("agent-shell-session-strategy", "{strategy}");"#
        ));
        let notes = format!("{dir_name}/notes.txt");
        d.with(move |ed| ed.call("find-file", vec![e8_core::Arg::Str(notes)]).unwrap());
        d.mx("agent-shell");
        d
    };
    let wait = |d: &Driven, f: &dyn Fn(&str) -> bool| {
        let start = std::time::Instant::now();
        while !f(&d.text()) {
            assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    };
    let first = editor("new");
    first.type_text("Remember the word heliotrope for later. Reply with just: noted. Use no tools.");
    first.press("C-c RET");
    wait(&first, &|t| t.matches("* You\n").count() == 2);
    drop(first);
    // Another editor, as after quitting E8, resumes the latest session there.
    let second = editor("latest");
    wait(&second, &|t| t.contains("Remember the word heliotrope") && t.ends_with("* You\n"));
    second.type_text("What word did I ask you to remember? Reply with just that word, and use no tools.");
    second.press("C-c RET");
    wait(&second, &|t| t.matches("* You\n").count() == 3);
    let text = second.text();
    eprintln!("{text}");
    let reply = &text[text.rfind("* Agent\n").unwrap()..];
    assert!(reply.to_lowercase().contains("heliotrope") && !reply.contains("[Error"), "{text}");
}

#[test]
#[ignore]
fn live_claude_code_asks_then_writes_a_file() {
    // A directory outside any repository, so the session works there.
    let dir = tempfile::tempdir().unwrap();
    let dir_name = std::fs::canonicalize(dir.path()).unwrap().display().to_string();
    std::fs::write(dir.path().join("notes.txt"), "notes\n").unwrap();
    let d = Driven::new(
        r#"e8.setVariable("agent-shell-agents", [["claude", ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]]]);
        e8.setVariable("agent-shell-default-agent", "claude");
        e8.setVariable("agent-shell-session-strategy", "new");
        e8.setVariable("acp-logging-enabled", true);"#,
    );
    // Started from a file there, as a user would, so the session is in that directory.
    let notes = format!("{dir_name}/notes.txt");
    d.with(move |ed| ed.call("find-file", vec![e8_core::Arg::Str(notes)]).unwrap());
    d.mx("agent-shell");
    assert_eq!(d.eval_expression("JSON.stringify(e8.variable('default-directory'))"), json!(json!(format!("{dir_name}/")).to_string()).to_string());
    d.type_text(&format!("Create the file {dir_name}/hello.txt, containing exactly the line hello. Use your file writing tool, and nothing else."));
    d.press("C-c RET");
    let start = std::time::Instant::now();
    let mut asked = Vec::new();
    while d.text().matches("* You\n").count() < 2 {
        assert!(start.elapsed() < std::time::Duration::from_secs(180), "{}", d.text());
        if let Some(q) = d.prompt().or_else(|| d.message()).filter(|q| q.starts_with("Let ")) {
            asked.push(q);
            d.press("y");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let text = d.text();
    eprintln!("{text}\nasked: {asked:?}");
    let traffic = d.eval_expression(
        r#"e8.bufferList().filter((b) => b.includes("traffic")).map((b) => e8.withCurrentBuffer(b, () => e8.bufferText(0, e8.bufferSize()))).join("")"#,
    );
    let traffic: String = serde_json::from_str(&traffic).unwrap_or(traffic);
    eprintln!("traffic: {}", traffic.lines().map(|l| l.split(" {").next().unwrap_or("")).collect::<Vec<_>>().join(" | "));
    // Whether it asks is Claude Code's choice, by its permission settings.
    assert_eq!(std::fs::read_to_string(dir.path().join("hello.txt")).unwrap().trim(), "hello");
}

/// A session gets E8's own tools: e8-mcp, beside the program, on
/// this editor's socket, and a word on them after the agent's system prompt.
#[test]
fn the_agent_gets_e8s_own_tools_when_this_editor_has_a_socket() {
    let Some(_) = python() else { return };
    let bin = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let program = bin.path().join("e8-mcp");
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let steps = vec![
        json!({"expect": {"method": "initialize"}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1}}}),
        json!({"expect": {"method": "session/new", "params": {
            "mcpServers": [{"name": "e8", "command": shown(&program), "args": ["--socket", "/tmp/e8-test.sock"], "env": []}],
            "_meta": {"systemPrompt": {}},
        }}}),
        json!({"send": {"id": 2, "result": {"sessionId": "s1"}}}),
        json!({"expect": {"method": "session/prompt"}}),
        end_turn("end_turn"),
    ];
    let source = format!(
        r#"e8.setVariable("invocation-directory", {});
        e8.setVariable("e8-mcp-socket", "/tmp/e8-test.sock");"#,
        json!(format!("{}/", shown(bin.path())))
    );
    let Some(s) = setup_with(steps, "hi", &source) else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert!(!text.contains("Error"), "{text}");
    let new = s.received().into_iter().find(|m| m["method"] == json!("session/new")).unwrap();
    assert!(new["params"]["_meta"]["systemPrompt"]["append"].as_str().unwrap().contains("running inside E8"));
    // Turned off, or with no socket, a session gets none.
    s.d.eval(
        r#"import("agent-shell").then((m: any) => {
          (globalThis as any).on = m.e8McpServer() !== undefined;
          e8.setVariable("agent-shell-e8-tools", false);
          (globalThis as any).off = m.e8McpServer() === undefined;
          e8.setVariable("agent-shell-e8-tools", true);
          e8.setVariable("e8-mcp-socket", null);
          (globalThis as any).unsocketed = m.e8McpServer() === undefined;
        });"#,
    );
    assert_eq!(s.d.eval_expression("[on, off, unsocketed]"), "[true,true,true]");
}

/// Initialize and a session, whose answer gives `session`'s keys too.
fn session_opening(session: Value) -> Vec<Value> {
    let mut result = json!({"sessionId": "s1"});
    result.as_object_mut().unwrap().extend(session.as_object().unwrap().clone());
    vec![
        json!({"expect": {"method": "initialize", "id": 1}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}}}),
        json!({"expect": {"method": "session/new", "id": 2}}),
        json!({"send": {"id": 2, "result": result}}),
    ]
}

/// A select setting as ACP's configOptions give one.
fn select(id: &str, category: &str, current: &str, values: &[(&str, &str)]) -> Value {
    json!({"id": id, "name": id[..1].to_uppercase() + &id[1..], "category": category, "type": "select", "currentValue": current,
        "options": values.iter().map(|(v, n)| json!({"value": v, "name": n})).collect::<Vec<_>>()})
}

fn claude_options(model: &str, effort: &str) -> Value {
    json!([
        select("mode", "mode", "auto", &[("default", "Manual"), ("plan", "Plan"), ("auto", "Auto")]),
        select("model", "model", model, &[("opus", "Opus 5.5"), ("sonnet", "Sonnet 5.5")]),
        select("effort", "thought_level", effort, &[("high", "High"), ("max", "Max")]),
        select("fast", "model_config", "off", &[("on", "On"), ("off", "Off")]),
    ])
}

/// Waits until `f` holds, failing after ten seconds.
fn wait_for(what: &str, f: impl Fn() -> bool) {
    let start = std::time::Instant::now();
    while !f() {
        assert!(start.elapsed() < std::time::Duration::from_secs(10), "never: {what}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn header(d: &Driven) -> String {
    js_string(d, "e8.variable(\"header-line-format\")")
}

#[test]
fn the_session_starts_with_the_buffer_and_its_model_is_picked_with_c_c_c_v() {
    let mut steps = session_opening(json!({"configOptions": claude_options("opus", "high")}));
    steps.extend([
        json!({"expect": {"method": "session/set_config_option", "id": 3, "params": {"sessionId": "s1", "configId": "model", "value": "sonnet"}}}),
        json!({"send": {"id": 3, "result": {"configOptions": claude_options("sonnet", "high")}}}),
        json!({"expect": {"method": "session/set_config_option", "id": 4, "params": {"configId": "effort", "value": "max"}}}),
        json!({"send": {"id": 4, "result": {"configOptions": claude_options("sonnet", "max")}}}),
        json!({"expect": {"method": "session/set_config_option", "id": 5, "params": {"configId": "fast", "value": "on"}}}),
        json!({"send": {"id": 5, "result": {}}}),
        json!({"sleep": 1}),
        update(json!({"sessionUpdate": "config_option_update", "configOptions": claude_options("opus", "max")})),
        json!({"sleep": 5}),
    ]);
    let Some(s) = setup(steps, "") else { return };
    // Before any request, the session is there and its settings show.
    wait_for("the settings show", || header(&s.d).starts_with(" Opus 5.5 · Auto · High  C-c RET send"));
    s.d.press("C-c C-v");
    assert_eq!(s.d.prompt().as_deref(), Some("Model (Opus 5.5): "));
    s.d.type_text("Sonnet 5.5");
    s.d.press("RET");
    wait_for("the model changes", || header(&s.d).starts_with(" Sonnet 5.5 · Auto · High"));
    assert_eq!(s.d.message().as_deref(), Some("Model: Sonnet 5.5"));
    // Code picks by a value's id as well as its name; C-c C-t is the thought level.
    s.d.eval(r#"e8.call("agent-shell-set-session-thought-level", "max")"#);
    wait_for("the effort changes", || header(&s.d).contains("· Max"));
    // Any setting, by C-c C-s's command; an answer without settings keeps the value picked.
    s.d.eval(r#"e8.call("agent-shell-set-session-config-option", "Fast", "On")"#);
    wait_for("fast mode is on", || s.d.message().as_deref() == Some("Fast: On"));
    // The agent's own changes show too.
    wait_for("the agent's update shows", || header(&s.d).starts_with(" Opus 5.5 · Auto · Max"));
    assert_eq!(s.d.text(), "* You\n", "nothing is written in the conversation");
}

#[test]
fn an_agent_with_only_modes_cycles_them_with_c_c_tab_or_c_tab() {
    let mut steps = session_opening(json!({"modes": {"currentModeId": "default", "availableModes": [
        {"id": "default", "name": "Ask"}, {"id": "plan", "name": "Plan"}]}}));
    steps.extend([
        json!({"expect": {"method": "session/set_mode", "id": 3, "params": {"sessionId": "s1", "modeId": "plan"}}}),
        json!({"send": {"id": 3, "result": {}}}),
        json!({"sleep": 1}),
        update(json!({"sessionUpdate": "current_mode_update", "currentModeId": "default"})),
        json!({"expect": {"method": "session/set_mode", "id": 4, "params": {"modeId": "plan"}}}),
        json!({"send": {"id": 4, "result": {}}}),
        json!({"sleep": 5}),
    ]);
    let Some(s) = setup(steps, "") else { return };
    wait_for("the mode shows", || header(&s.d).starts_with(" Ask  C-c RET"));
    s.d.press("C-c TAB");
    wait_for("the mode moves on", || header(&s.d).starts_with(" Plan  "));
    assert_eq!(s.d.message().as_deref(), Some("Mode: Plan"));
    wait_for("the agent's own mode change shows", || header(&s.d).starts_with(" Ask  "));
    s.d.press("C-<tab>");
    wait_for("C-<tab> moves it on too", || header(&s.d).starts_with(" Plan  "));
    // It offers no model, and says so.
    s.d.press("C-c C-v");
    assert_eq!(s.d.message().as_deref(), Some("fake offers no model to pick"));
}

/// Whether the character at `at` in the shell's buffer is hidden.
/// Whether the character `at` bytes into `text`, the shell's buffer's text, is hidden.
/// Two turns, as [`the_transcript_is_read_only_and_undo_reaches_only_the_request`] has them.
fn two_turns() -> Vec<Value> {
    let mut steps = opening("hi");
    steps.extend([
        chunk("Hello"),
        end_turn("end_turn"),
        json!({"expect": {"method": "session/prompt", "id": 4, "params": {"prompt": [{"type": "text", "text": "second one"}]}}}),
        chunk("Again"),
        json!({"send": {"id": 4, "result": {"stopReason": "end_turn"}}}),
    ]);
    steps
}

#[test]
fn m_p_and_m_n_bring_earlier_requests_back_to_the_prompt_and_m_r_picks_one() {
    let Some(s) = setup(two_turns(), "hi") else { return };
    s.d.press("C-c RET");
    s.finished();
    s.d.type_text("second one");
    s.d.press("C-c RET");
    s.d.until(|t| t.matches("* You\n").count() == 3);
    let text = s.d.text();
    assert!(text.ends_with("* You\nsecond one\n\n* Agent\nAgain\n\n* You\n"), "{text}");
    s.d.type_text("typed so far");
    // Back through the requests sent, newest first, as a shell's M-p.
    s.d.press("M-p");
    assert!(s.d.text().ends_with("* You\nsecond one"), "{}", s.d.text());
    assert_eq!(s.d.message().as_deref(), Some("History item: 1"));
    s.d.press("M-p");
    assert!(s.d.text().ends_with("* You\nhi"), "{}", s.d.text());
    s.d.press("M-p");
    assert!(s.d.message().is_some_and(|m| m.contains("Beginning of history")), "{:?}", s.d.message());
    assert!(s.d.text().ends_with("* You\nhi"), "{}", s.d.text());
    // Forward again, to what was being typed.
    s.d.press("M-n");
    assert!(s.d.text().ends_with("* You\nsecond one"), "{}", s.d.text());
    s.d.press("M-n");
    assert!(s.d.text().ends_with("* You\ntyped so far"), "{}", s.d.text());
    assert_eq!(s.d.message().as_deref(), Some("Input restored"));
    s.d.press("M-n");
    assert!(s.d.message().is_some_and(|m| m.contains("End of history")), "{:?}", s.d.message());
    // M-r picks one with completion.
    s.d.press("M-r");
    assert!(s.d.prompt().is_some_and(|p| p.starts_with("History")), "{:?}", s.d.prompt());
    s.d.type_text("hi");
    s.d.press("RET");
    assert!(s.d.text().ends_with("* You\nhi"), "{}", s.d.text());
    // The transcript above is as it was throughout.
    assert!(s.d.text().starts_with(&text), "{}", s.d.text());
    // The history is every buffer's, kept between sessions by savehist-mode.
    assert_eq!(s.d.eval_expression(r#"JSON.stringify(e8.variable("agent-shell-history"))"#), r#""[\"second one\",\"hi\"]""#);
    assert_eq!(
        s.d.eval_expression(r#"(e8.variable("savehist-additional-variables") as string[]).includes("agent-shell-history")"#),
        "true"
    );
}

#[test]
fn letters_in_the_transcript_move_about_it_and_type_at_the_prompt() {
    let Some(s) = setup(two_turns(), "hi") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert_eq!(text, "* You\nhi\n\n* Agent\nHello\n\n* You\n");
    let agent = text.find("* Agent").unwrap();
    let prompt = text.rfind("* You").unwrap();
    // In the transcript, Org's speed commands run anywhere, not only at a heading's start.
    s.d.eval(&format!("e8.gotoChar({})", text.find("Hello").unwrap() + 2));
    s.d.press("p");
    assert_eq!(s.d.point(), agent);
    s.d.press("p");
    assert_eq!(s.d.point(), 0);
    s.d.press("n");
    assert_eq!(s.d.point(), agent);
    s.d.press("n");
    assert_eq!(s.d.point(), prompt);
    s.d.press("n");
    assert!(s.d.message().is_some_and(|m| m.contains("Boundary reached")), "{:?}", s.d.message());
    assert_eq!(s.d.point(), prompt);
    s.d.press("p");
    assert_eq!(s.d.point(), agent);
    // c folds the agent's turn, and opens it again.
    let hello = text.find("Hello").unwrap();
    s.d.press("c");
    assert!(hidden_at(&s.d, hello), "folded");
    s.d.press("c");
    assert!(!hidden_at(&s.d, hello), "shown again");
    // Letters that edit stay refused, and the transcript stands.
    s.d.eval(&format!("e8.gotoChar({hello})"));
    s.d.press("t");
    assert!(s.d.message().is_some_and(|m| m.contains("read-only")), "{:?}", s.d.message());
    assert_eq!(s.d.text(), text);
    // At the prompt, letters type.
    s.d.eval("e8.gotoChar(e8.bufferSize())");
    s.d.type_text("np");
    assert!(s.d.text().ends_with("* You\nnp"), "{}", s.d.text());
}

/// The answer to initialize of an agent that can list, load and resume its sessions.
fn initialized_with_sessions() -> Vec<Value> {
    vec![
        json!({"expect": {"method": "initialize", "id": 1}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "authMethods": [],
            "agentCapabilities": {"loadSession": true, "sessionCapabilities": {"list": {}, "resume": {}}}}}}),
    ]
}

fn update_in(session: &str, update: Value) -> Value {
    json!({"send": {"method": "session/update", "params": {"sessionId": session, "update": update}}})
}

/// Waits for the prompt that asks which session to resume.
fn wait_prompt(d: &Driven, starts: &str) -> String {
    let start = std::time::Instant::now();
    loop {
        if let Some(p) = d.prompt().filter(|p| p.starts_with(starts)) {
            return p;
        }
        assert!(start.elapsed() < std::time::Duration::from_secs(10), "never asked {starts:?}: {:?}", d.text());
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn an_earlier_session_is_resumed_its_conversation_replayed_and_the_agent_carries_on() {
    let mut steps = initialized_with_sessions();
    steps.extend([
        json!({"expect": {"method": "session/list", "id": 2, "params": {}}}),
        json!({"send": {"id": 2, "result": {"sessions": [
            {"sessionId": "old", "title": "Fix the tests", "updatedAt": "2026-11-07T10:00:00Z"},
            {"sessionId": "older", "title": "Something else", "updatedAt": "2026-11-01T10:00:00Z"},
        ]}}}),
        json!({"expect": {"method": "session/load", "id": 3, "params": {"sessionId": "old", "mcpServers": []}}}),
        update_in("old", json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "Run the tests"}})),
        update_in("old", json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "cargo test", "kind": "execute",
            "status": "pending", "rawInput": {"command": "cargo test"}})),
        update_in("old", json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "```console\nok\n```"}}]})),
        update_in("old", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "They **pass**."}})),
        update_in("old", json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "Thanks"}})),
        update_in("old", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "You're welcome."}})),
        json!({"send": {"id": 3, "result": {}}}),
        json!({"expect": {"method": "session/prompt", "id": 4, "params": {"sessionId": "old", "prompt": [{"type": "text", "text": "And now?"}]}}}),
        update_in("old", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Carrying on."}})),
        json!({"send": {"id": 4, "result": {"stopReason": "end_turn"}}}),
    ]);
    let Some(s) = open(vec![steps], "") else { return };
    // Typed while the agent starts, the request waits below the replayed conversation.
    s.d.type_text("And now?");
    let asked = wait_prompt(&s.d, "Resume a session of fake: ");
    assert_eq!(asked, "Resume a session of fake: ");
    s.d.type_text("Fix");
    s.d.press("TAB");
    assert!(s.d.minibuffer_input().starts_with("Fix the tests · 2026-11-07"), "{}", s.d.minibuffer_input());
    s.d.press("RET");
    s.d.until(|t| t.contains("You're welcome.") && t.ends_with("* You\nAnd now?"));
    let text = s.d.text();
    assert!(
        text.starts_with("* You\nRun the tests\n\n* Agent\n→ ~cargo test~\n#+begin_src console\nok\n#+end_src\nThey *pass*.\n\n* You\nThanks\n\n* Agent\nYou're welcome.\n\n* You\nAnd now?"),
        "{text}"
    );
    assert_eq!(s.d.message().as_deref(), Some("Resumed Fix the tests"));
    // The replayed tool output is folded, as a finished call's is, and every
    // reply but the last, which shows where the session was left.
    assert!(hidden_in(&s.d, &text, text.find("ok\n").unwrap()), "folded");
    assert!(hidden_in(&s.d, &text, text.find("They").unwrap()), "an earlier reply is folded");
    assert!(!hidden_in(&s.d, &text, text.find("You're welcome").unwrap()), "the last reply shows");
    assert!(!hidden_in(&s.d, &text, text.find("Thanks").unwrap()), "the requests show");
    // TAB on its heading opens an earlier reply, as on any Org heading.
    s.d.eval(&format!("e8.gotoChar({})", text.find("* Agent").unwrap()));
    s.d.press("TAB");
    assert!(!hidden_in(&s.d, &text, text.find("They").unwrap()), "opened");
    // The replay is the transcript: read-only, and not undone.
    s.d.eval(&format!("e8.gotoChar({})", text.find("Thanks").unwrap()));
    s.d.press("DEL");
    assert_eq!(s.d.text(), text);
    s.d.eval("e8.gotoChar(e8.bufferSize())");
    // The agent carries on in the session it had.
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("Carrying on.") && t.ends_with("* You\n"));
    assert!(s.d.text().ends_with("* You\nAnd now?\n\n* Agent\nCarrying on.\n\n* You\n"), "{}", s.d.text());
}

#[test]
fn a_new_session_can_be_chosen_instead_and_none_is_asked_without_earlier_ones() {
    let mut steps = initialized_with_sessions();
    steps.extend([
        json!({"expect": {"method": "session/list", "id": 2}}),
        json!({"send": {"id": 2, "result": {"sessions": [{"sessionId": "old", "title": "Fix the tests"}]}}}),
        json!({"expect": {"method": "session/new", "id": 3}}),
        json!({"send": {"id": 3, "result": {"sessionId": "s1"}}}),
    ]);
    let Some(s) = open(vec![steps], "") else { return };
    wait_prompt(&s.d, "Resume a session of fake: ");
    s.d.type_text("New session");
    s.d.press("RET");
    wait_for("the new session", || s.received().iter().any(|m| m["method"] == "session/new"));
    assert_eq!(s.d.text(), "* You\n");

    // With no earlier sessions, nothing is asked.
    let mut steps = initialized_with_sessions();
    steps.extend([
        json!({"expect": {"method": "session/list", "id": 2}}),
        json!({"send": {"id": 2, "result": {"sessions": []}}}),
        json!({"expect": {"method": "session/new", "id": 3}}),
        json!({"send": {"id": 3, "result": {"sessionId": "s1"}}}),
    ]);
    let Some(s) = open(vec![steps], "") else { return };
    wait_for("the new session", || s.received().iter().any(|m| m["method"] == "session/new"));
    assert!(s.d.prompt().is_none(), "{:?}", s.d.prompt());

    // Nor with agent-shell-session-strategy "new", which does not list them.
    let mut steps = initialized_with_sessions();
    steps.extend([
        json!({"expect": {"method": "session/new", "id": 2}}),
        json!({"send": {"id": 2, "result": {"sessionId": "s1"}}}),
    ]);
    let Some(s) = open(vec![steps], r#"e8.setVariable("agent-shell-session-strategy", "new");"#) else { return };
    wait_for("the new session", || s.received().iter().any(|m| m["method"] == "session/new"));
    assert!(s.received().iter().all(|m| m["method"] != "session/list"));
}

#[test]
fn an_agent_that_stops_is_started_again_in_the_same_session() {
    let mut first = vec![
        json!({"expect": {"method": "initialize", "id": 1}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "authMethods": [],
            "agentCapabilities": {"sessionCapabilities": {"resume": {}}}}}}),
        json!({"expect": {"method": "session/new", "id": 2}}),
        json!({"send": {"id": 2, "result": {"sessionId": "s1"}}}),
        json!({"expect": {"method": "session/prompt", "id": 3}}),
    ];
    first.extend([json!({"sleep": 0.2}), json!({"exit": 1})]);
    let second = vec![
        json!({"expect": {"method": "initialize", "id": 1}}),
        json!({"send": {"id": 1, "result": {"protocolVersion": 1, "authMethods": [],
            "agentCapabilities": {"sessionCapabilities": {"resume": {}}}}}}),
        json!({"expect": {"method": "session/resume", "id": 2, "params": {"sessionId": "s1"}}}),
        json!({"send": {"id": 2, "result": {}}}),
        json!({"expect": {"method": "session/prompt", "id": 3, "params": {"sessionId": "s1", "prompt": [{"type": "text", "text": "again"}]}}}),
        update(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Still here."}})),
        json!({"send": {"id": 3, "result": {"stopReason": "end_turn"}}}),
    ];
    let Some(s) = open(vec![first, second], "") else { return };
    s.d.type_text("go");
    s.d.press("C-c RET");
    s.finished();
    s.d.press("M->");
    s.d.type_text("again");
    s.d.press("C-c RET");
    s.d.until(|t| t.contains("Still here."));
    assert!(s.d.text().contains("[Starting fake again, in the same session.]\nStill here."), "{}", s.d.text());
}

#[test]
fn slash_commands_complete_at_the_start_of_a_request_and_say_what_they_do() {
    let mut steps = session_opening(json!({}));
    steps.push(update(json!({"sessionUpdate": "available_commands_update", "availableCommands": [
        {"name": "compact", "description": "Clear the conversation but keep a summary of it in context", "input": null},
        {"name": "context", "description": "Show what fills the context", "input": null},
        {"name": "code-review:code-review", "description": "(code-review) Code review a pull request", "input": {"hint": "PR number"}},
    ]})));
    let Some(s) = open(vec![steps], "") else { return };
    // As a completion-at-point function, once the agent has said its commands.
    s.d.type_text("/co");
    let capf = r#"JSON.stringify(e8.runHookWithArgsUntilSuccess("completion-at-point-functions") ?? null)"#;
    wait_for("the commands", || s.d.eval_expression(capf) != json!("null").to_string());
    assert_eq!(
        js_string(&s.d, capf),
        json!([6, 9, ["/compact", "/context", "/code-review:code-review"]]).to_string()
    );
    // TAB completes one, and says what it does.
    s.d.type_text("nt");
    s.d.press("TAB");
    assert_eq!(s.d.text(), "* You\n/context");
    assert_eq!(s.d.message().as_deref(), Some("/context: Show what fills the context"));
    // With several, the minibuffer asks which, and what one takes is said too.
    s.d.press("C-a");
    s.d.press("C-k");
    s.d.type_text("/co");
    s.d.press("TAB");
    assert!(s.d.prompt().is_some_and(|p| p.starts_with("Complete")), "{:?}", s.d.prompt());
    s.d.type_text("de-review:code-review");
    s.d.press("RET");
    assert_eq!(s.d.text(), "* You\n/code-review:code-review");
    assert_eq!(s.d.message().as_deref(), Some("/code-review:code-review: (code-review) Code review a pull request (takes PR number)"));
    // Only at the start of the request: a / later in it is text, and TAB is Org's.
    s.d.press("C-a");
    s.d.press("C-k");
    s.d.type_text("see /co");
    assert_eq!(s.d.eval_expression(capf), json!("null").to_string());
    s.d.press("TAB");
    assert_eq!(s.d.text(), "* You\nsee /co");
}

fn hidden_in(d: &Driven, text: &str, at: usize) -> bool {
    hidden_at(d, text[..at].chars().count())
}

fn hidden_at(d: &Driven, at: usize) -> bool {
    d.with(move |ed| {
        let shell = ed.find_buffer("*agent-shell: fake*").or_else(|| ed.find_buffer("*agent-shell: claude*")).unwrap();
        let b = &ed.buffers()[shell];
        ed.invisible_in(b, at).is_some()
    })
}

fn tool_update(id: &str, extra: Value) -> Value {
    let mut u = json!({"sessionUpdate": "tool_call_update", "toolCallId": id});
    u.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    update(u)
}

#[test]
fn tool_output_and_thinking_fold_as_they_stream_and_tab_keeps_one_open() {
    let mut steps = opening("go");
    steps.extend([
        update(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Thinking\nhard"}})),
        json!({"sleep": 1.5}),
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Run make", "kind": "execute", "status": "in_progress"})),
        tool_update("t1", json!({"content": [{"type": "content", "content": {"type": "text", "text": "line one"}}]})),
        json!({"sleep": 1.5}),
        tool_update("t1", json!({"status": "completed", "content": [{"type": "content", "content": {"type": "text", "text": "line one\nline two"}}]})),
        json!({"sleep": 1.5}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "go") else { return };
    s.d.press("C-c RET");
    // The thinking folds into its line while it is still coming.
    s.d.until(|t| t.contains("hard"));
    let t = s.d.text();
    assert!(hidden_in(&s.d, &t, t.find("hard").unwrap()), "{t}");
    // So does the tool's output, as soon as there is some.
    s.d.until(|t| t.contains("line one"));
    let t = s.d.text();
    let line = t.find("→ ").unwrap();
    assert!(hidden_in(&s.d, &t, t.find("line one").unwrap()), "{t}");
    assert!(t.contains("#+begin_thinking\nThinking\nhard\n#+end_thinking\n"), "{t}");
    assert!(hidden_in(&s.d, &t, t.find("#+end_thinking").unwrap()), "the thinking's end folds with it");
    // TAB opens it, and the next update keeps it open.
    s.d.eval(&format!("e8.gotoChar({})", line + 2));
    s.d.press("TAB");
    assert!(!hidden_in(&s.d, &t, t.find("line one").unwrap()));
    s.d.until(|t| t.contains("line two"));
    let t = s.d.text();
    assert!(!hidden_in(&s.d, &t, t.find("line two").unwrap()), "still open after the update");
    let t = s.finished();
    assert!(!hidden_in(&s.d, &t, t.find("line two").unwrap()), "and once the turn ends");
}

#[test]
fn a_call_s_diff_shows_while_its_permission_is_asked() {
    let mut steps = opening("edit");
    steps.extend([
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.txt", "kind": "edit", "status": "pending",
            "content": [{"type": "diff", "path": "/x/a.txt", "oldText": "one", "newText": "two"}]})),
        json!({"send": {"id": 50, "method": "session/request_permission", "params": {"sessionId": "s1",
            "toolCall": {"toolCallId": "t1", "title": "Edit a.txt"},
            "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]}}}),
        json!({"expect": {"id": 50}}),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "edit") else { return };
    s.d.press("C-c RET");
    s.wait_asked();
    let t = s.d.text();
    assert!(!hidden_in(&s.d, &t, t.find("+two").unwrap()), "the diff shows while it asks: {t}");
    s.d.press("y");
    let t = s.finished();
    assert!(hidden_in(&s.d, &t, t.find("+two").unwrap()), "and folds once answered");
}

#[test]
fn tool_lines_are_short_and_claude_s_bookkeeping_is_left_out() {
    let mut steps = opening("look");
    let home = std::env::var("HOME").unwrap();
    steps.extend([
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t0", "title": "ToolSearch", "kind": "other", "status": "pending",
            "_meta": {"claudeCode": {"toolName": "ToolSearch"}}})),
        tool_update("t0", json!({"status": "completed", "content": [{"type": "content", "content": {"type": "text", "text": "tools"}}]})),
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "mcp__e8__screen", "kind": "other", "status": "pending",
            "_meta": {"claudeCode": {"toolName": "mcp__e8__screen"}}})),
        tool_update("t1", json!({"rawInput": {"window": 1}, "status": "completed"})),
        update(json!({"sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Terminal", "kind": "execute", "status": "pending",
            "_meta": {"claudeCode": {"toolName": "Bash"}}})),
        tool_update("t2", json!({"title": format!("ls {home}/notes"), "rawInput": {"command": "ls", "description": "List the sources"}, "status": "completed"})),
        end_turn("end_turn"),
    ]);
    let Some(s) = setup(steps, "look") else { return };
    s.d.press("C-c RET");
    let t = s.finished();
    assert!(!t.contains("ToolSearch") && !t.contains("tools"), "{t}");
    assert!(t.contains("→ ~e8: screen window=1~\n"), "{t}");
    assert!(t.contains("→ =ls ~/notes= — List the sources\n"), "{t}");
    // ~code~ shows without its tildes here.
    s.d.with(|ed| ed.redisplay());
    // In characters, as buffer positions are: the arrow is three bytes.
    let at = t[..t.find("~e8: screen").unwrap()].chars().count();
    assert!(hidden_at(&s.d, at) && !hidden_at(&s.d, at + 1), "{t}");
    // Quitting asks nothing about the agent's process.
    assert_eq!(js_string(&s.d, "String(e8.processList().filter((p) => e8.processQueryOnExitFlag(p)).length)"), "0");
}

#[test]
fn the_transcript_is_read_only_and_undo_reaches_only_the_request() {
    let mut steps = opening("hi");
    steps.extend([
        chunk("Hello"),
        end_turn("end_turn"),
        json!({"expect": {"method": "session/prompt", "id": 4, "params": {"prompt": [{"type": "text", "text": "next"}]}}}),
        chunk("Again"),
        json!({"send": {"id": 4, "result": {"stopReason": "end_turn"}}}),
    ]);
    let Some(s) = setup(steps, "hi") else { return };
    s.d.press("C-c RET");
    let text = s.finished();
    assert_eq!(text, "* You\nhi\n\n* Agent\nHello\n\n* You\n");
    // Nothing above the new heading can be typed into, deleted, or undone.
    let hello = text.find("Hello").unwrap();
    s.d.eval(&format!("e8.gotoChar({hello})"));
    s.d.type_text("x");
    assert!(s.d.message().is_some_and(|m| m.contains("read-only")), "{:?}", s.d.message());
    s.d.press("C-d");
    s.d.press("DEL");
    assert_eq!(s.d.text(), text, "the agent's text is read-only");
    s.d.eval("e8.gotoChar(0)");
    s.d.type_text("x");
    assert_eq!(s.d.text(), text, "nothing goes before the transcript");
    s.d.eval("e8.gotoChar(e8.bufferSize())");
    s.d.press("C-/");
    assert_eq!(s.d.text(), text, "undo takes nothing back");
    assert!(s.d.message().is_some_and(|m| m.contains("No further undo")), "{:?}", s.d.message());
    // The request is typed, and undone, as any text.
    s.d.type_text("next");
    assert!(s.d.text().ends_with("* You\nnext"), "{}", s.d.text());
    for _ in 0..4 {
        if s.d.text().ends_with("* You\n") {
            break;
        }
        s.d.press("C-/");
    }
    assert_eq!(s.d.text(), text, "undo takes back the typing, and only that");
    s.d.type_text("next");
    s.d.press("C-c RET");
    s.d.until(|t| t.matches("* You\n").count() == 3);
    let text = s.d.text();
    assert!(text.ends_with("* You\nnext\n\n* Agent\nAgain\n\n* You\n"), "{text}");
    // Sent, the request is the transcript's too, and the undo history starts afresh.
    s.d.eval(&format!("e8.gotoChar({})", text.find("next").unwrap()));
    s.d.type_text("x");
    assert_eq!(s.d.text(), text, "a sent request is read-only");
    s.d.eval("e8.gotoChar(e8.bufferSize())");
    s.d.press("C-/");
    assert_eq!(s.d.text(), text);
    assert!(s.d.message().is_some_and(|m| m.contains("No further undo")), "{:?}", s.d.message());
}
