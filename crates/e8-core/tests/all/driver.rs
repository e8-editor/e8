//! The editor on a thread of its own (docs/multithreading.md, step 3):
//! keys in order, frames published once input stops, timers firing with
//! no key, and C-g stopping a long command while the last frame stays
//! there to draw.

use std::rc::Rc;
use std::time::{Duration, Instant};

use e8_core::driver::Driver;
use e8_core::{Editor, Key, KeyCode};

fn driver() -> Driver {
    Driver::spawn(|_| Box::new(()), |ed| {
        ed.redisplay();
        vec![ed.describe_frame(ed.selected_frame(), 1.0)]
    }, || {})
}

fn key(s: &str) -> Key {
    Key::parse(s).unwrap()
}

/// Waits until the editor publishes a frame newer than `after`.
fn published_after(d: &Driver, after: u64) -> u64 {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let generation = d.published().generation;
        if generation > after {
            return generation;
        }
        assert!(Instant::now() < until, "no frame published");
        std::thread::yield_now();
    }
}

#[test]
fn keys_run_in_order_and_frames_follow() {
    let d = driver();
    for c in "hello".chars() {
        d.key(Key { code: KeyCode::Char(c), ctrl: false, meta: false, shift: false });
    }
    d.key(key("C-a"));
    d.key(key("C-k"));
    d.key(key("C-y"));
    assert_eq!(d.with(|ed| (ed.buffer().slice(0..ed.buffer().len()), ed.buffer().point())), ("hello".to_string(), 5));
    d.with(|_| ());
    let seen = published_after(&d, 0);
    let p = d.published();
    assert!(seen >= 1);
    assert!(!p.frames.is_empty(), "the frame is described");
}

#[test]
fn timers_fire_with_no_input() {
    let d = driver();
    d.with(|ed| {
        ed.run_with_timer(0.05, None, Rc::new(|ed: &mut Editor, _| {
            ed.set_variable("fired", e8_core::Value::Bool(true));
            Ok(())
        }));
    });
    let until = Instant::now() + Duration::from_secs(5);
    while !d.with(|ed| ed.variable("fired").is_some_and(|v| v.is_true())) {
        assert!(Instant::now() < until, "the timer never fired");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn c_g_stops_a_long_command_while_the_last_frame_stays() {
    let d = driver();
    d.with(|ed| ed.type_text(&"a".repeat(30_000)));
    let before = published_after(&d, 0);
    // A search that backtracks without end, as a command stuck in a loop.
    d.run(|ed| {
        let options = e8_core::SearchOptions { regexp: true, ..Default::default() };
        let result = ed.search("\\(a*\\)*b", 0, &options);
        ed.set_variable("searched", e8_core::Value::Bool(result.is_err_and(|e| e.is("quit"))));
    });
    std::thread::sleep(Duration::from_millis(200));
    // Meanwhile the screen has the last frame to draw.
    assert!(!d.published().frames.is_empty());
    let asked = Instant::now();
    d.key(key("C-g"));
    let quit = d.with(|ed| ed.variable("searched").is_some_and(|v| v.is_true()));
    assert!(quit, "the search was quit");
    assert!(asked.elapsed() < Duration::from_secs(2), "promptly: {:?}", asked.elapsed());
    // The C-g the search took is not read again as a key.
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)), None);
    assert!(published_after(&d, before) > before);
    // And C-g with nothing running is keyboard-quit.
    d.key(key("C-g"));
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("Quit"));
}

#[test]
fn c_g_after_a_queued_key_is_still_keyboard_quit() {
    let d = driver();
    // The editor is busy until both keys are queued, so `x` runs first and
    // its command starts by clearing the quit flag the C-g set.
    let (release, wait) = std::sync::mpsc::channel::<()>();
    d.run(move |_| {
        let _ = wait.recv();
    });
    d.key(key("x"));
    d.key(key("C-g"));
    release.send(()).unwrap();
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("Quit"));
    assert_eq!(d.with(|ed| ed.buffer().slice(0..ed.buffer().len())), "x");
}

#[test]
fn a_panic_in_a_command_is_reported_and_the_editor_goes_on() {
    let d = driver();
    d.run(|_| panic!("something broke"));
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("Internal error: something broke"));
    d.key(key("x"));
    assert_eq!(d.with(|ed| ed.buffer().slice(0..ed.buffer().len())), "x");
    // A panic inside a command leaves later commands as they were: each
    // still its own undo step, as one that thought itself nested would not be.
    d.with(|ed| {
        ed.define_command(e8_core::Command::new("break", "Panics partway.", |_, _| panic!("partway")));
        ed.define_command(e8_core::Command::new("put-a", "Inserts a.", |ed, _| ed.insert("a")));
        ed.define_command(e8_core::Command::new("put-b", "Inserts b.", |ed, _| ed.insert("b")));
    });
    d.run(|ed| {
        let _ = ed.call("break", vec![]);
    });
    d.run(|ed| ed.call("put-a", vec![]).unwrap());
    d.run(|ed| ed.call("put-b", vec![]).unwrap());
    d.key(key("C-/"));
    assert_eq!(d.with(|ed| ed.buffer().slice(0..ed.buffer().len())), "xa", "undo takes back the last call alone");
}

#[test]
fn process_output_arrives_with_no_key() {
    let d = driver();
    d.with(|ed| {
        ed.get_buffer_create("out");
        ed.make_process(e8_core::ProcessSpec {
            name: "echo".into(),
            buffer: Some("out".into()),
            command: vec!["sh".into(), "-c".into(), "sleep 0.1; echo hello".into()],
            directory: None,
            env: Vec::new(),
            merge_stderr: true,
            stderr_buffer: None,
            stderr_process: None,
            filter: None,
            sentinel: None,
            pty: false,
            coding: None,
        })
        .unwrap();
    });
    let until = Instant::now() + Duration::from_secs(5);
    let text = |d: &Driver| {
        d.with(|ed| {
            let i = ed.find_buffer("out").unwrap();
            let b = &ed.buffers()[i];
            b.slice(0..b.len())
        })
    };
    while !text(&d).contains("hello") {
        assert!(Instant::now() < until, "the output never came");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn settling_waits_for_the_input_sent_while_a_process_wakes_the_loop() {
    let d = driver();
    d.with(|ed| {
        ed.make_process(e8_core::ProcessSpec {
            name: "chatter".into(),
            buffer: None,
            command: vec!["sh".into(), "-c".into(), "i=0; while [ $i -lt 400 ]; do echo $i; sleep 0.002; i=$((i+1)); done".into()],
            directory: None,
            env: Vec::new(),
            merge_stderr: true,
            stderr_buffer: None,
            stderr_process: None,
            filter: None,
            sentinel: None,
            pty: false,
            coding: None,
        })
        .unwrap();
    });
    // Each wake from the process is input the driver did not send: settle
    // waits for what it sent, however many wakes came between.
    let ran = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    for i in 1..=100 {
        let counter = ran.clone();
        d.run(move |_| {
            std::thread::sleep(Duration::from_millis(1));
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        d.settle();
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), i, "settled before the input ran");
    }
}

#[test]
fn a_describe_that_panics_leaves_the_last_frames() {
    let calls = std::sync::atomic::AtomicU32::new(0);
    let d = Driver::spawn(|_| Box::new(()), move |ed| {
        if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
            panic!("describe broke");
        }
        ed.redisplay();
        vec![ed.describe_frame(ed.selected_frame(), 1.0)]
    }, || {});
    let first = published_after(&d, 0);
    assert!(!d.published().frames.is_empty());
    d.key(key("x"));
    published_after(&d, first);
    assert!(!d.published().frames.is_empty(), "the window does not go blank");
}

#[test]
fn nesting_too_deep_is_an_error_not_a_crash() {
    let d = driver();
    // Each nested edit is a command loop on the editor thread's stack.
    for _ in 0..1100 {
        d.run(|ed| {
            if let Err(e) = ed.call("recursive-edit", vec![]) {
                ed.message(e.to_string());
            }
        });
    }
    let (depth, echo) = d.with(|ed| (ed.recursion_depth(), ed.echo().map(str::to_string)));
    assert_eq!(depth, 1000);
    assert_eq!(echo.as_deref(), Some("Lisp nesting exceeds ‘max-lisp-eval-depth’: 1001"));
}

#[test]
fn a_timer_cancelled_by_one_before_it_in_the_round_does_not_run() {
    let mut ed = Editor::new();
    let second = Rc::new(std::cell::Cell::new(0u64));
    let cancels = second.clone();
    ed.run_with_timer(0.01, None, Rc::new(move |ed: &mut Editor, _| {
        ed.cancel_timer(cancels.get());
        Ok(())
    }));
    second.set(ed.run_with_timer(0.01, None, Rc::new(|ed: &mut Editor, _| {
        ed.set_variable("ran", e8_core::Value::Bool(true));
        Ok(())
    })));
    ed.advance_clock(Duration::from_millis(20));
    ed.run_timers();
    assert!(ed.variable("ran").is_none(), "the cancelled timer ran");
}

#[test]
fn what_setup_asks_waits_for_an_answer() {
    // As desktop asks in after-init-hook about a desktop another E8 has locked.
    let d = Driver::spawn(
        |ed| {
            let answer = ed.y_or_n_p("Use it anyway? ");
            ed.set_variable("answer", e8_core::Value::Str(format!("{answer:?}")));
            Box::new(())
        },
        |ed| {
            ed.redisplay();
            vec![ed.describe_frame(ed.selected_frame(), 1.0)]
        },
        || {},
    );
    // The question is drawn while it waits.
    let until = Instant::now() + Duration::from_secs(5);
    while d.with(|ed| ed.prompt().is_none()) {
        assert!(Instant::now() < until, "no question asked");
        std::thread::yield_now();
    }
    d.key(key("y"));
    let answer = d.with(|ed| ed.variable("answer").and_then(|v| v.as_str().map(String::from)));
    assert_eq!(answer.as_deref(), Some("Ok(true)"));
}

/// The message the echo area shows in the newest frame published.
fn echo_published(d: &Driver) -> Vec<String> {
    match d.published().frames.first().map(|f| &f.echo) {
        Some(e8_core::frame_description::Echo::Message(lines)) => lines.clone(),
        _ => Vec::new(),
    }
}

/// Code that runs a while, as init.ts installing packages: the frame is
/// shown before it starts, and each message it shows is drawn as it comes,
/// as Emacs's message redisplays at once, rather than only once it is done.
#[test]
fn messages_from_code_that_runs_a_while_are_drawn_as_they_come() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU8, Ordering};
    // The step the test lets the editor's code go on to.
    let step = Arc::new(AtomicU8::new(0));
    let go = step.clone();
    let wait_for = move |n: u8| {
        let until = Instant::now() + Duration::from_secs(10);
        while go.load(Ordering::SeqCst) < n {
            assert!(Instant::now() < until, "the test did not go on");
            std::thread::sleep(Duration::from_millis(1));
        }
    };
    let d = Driver::spawn(
        move |ed| {
            ed.redisplay_now();
            wait_for(1);
            // Long enough that its messages are not those of a quick command.
            std::thread::sleep(Duration::from_millis(150));
            ed.message("Installing 2 packages... 1/2");
            wait_for(2);
            std::thread::sleep(Duration::from_millis(60));
            ed.message("Installing 2 packages... 2/2");
            wait_for(3);
            Box::new(())
        },
        |ed| {
            ed.redisplay();
            vec![ed.describe_frame(ed.selected_frame(), 1.0)]
        },
        || {},
    );
    let shown = published_after(&d, 0);
    assert!(echo_published(&d).is_empty());
    step.store(1, Ordering::SeqCst);
    let shown = published_after(&d, shown);
    assert_eq!(echo_published(&d), ["Installing 2 packages... 1/2"]);
    step.store(2, Ordering::SeqCst);
    published_after(&d, shown);
    assert_eq!(echo_published(&d), ["Installing 2 packages... 2/2"]);
    step.store(3, Ordering::SeqCst);
    d.with(|_| ());
}
