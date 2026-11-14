//! A look at xwidgets' web views in a real window (ADR 0089), which the
//! tests cannot open: makes an xwidget, loads a page into it, runs a
//! script once it has loaded, writes each `xwidget-event` and the script's
//! result to a file, and closes the window after a few seconds.
//!
//! `cargo run -p e8-gui --example xwidget_smoke -- OUT-FILE`

use std::io::Write;
use std::time::{Duration, Instant};

use e8_core::{Editor, Function, Value};
use e8_gui::E8App;

struct Smoke {
    app: E8App,
    frames: u32,
    start: Instant,
}

fn log(out: &str, line: String) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(out) {
        let _ = writeln!(f, "{line}");
    }
}

fn setup(ed: &mut Editor, out: String) {
    let callback_out = out.clone();
    let callback = Value::Function(Function::new(Some("smoke-callback"), move |_, args| {
        log(&callback_out, format!("callback {:?}", args.first()));
        Ok(Value::Null)
    }));
    // As xwidget.el's xwidget-webkit-callback, from `last-input-event`.
    ed.defun(
        "xwidget-event-handler",
        Function::new(Some("xwidget-event-handler"), move |ed, _| {
            let event = ed.variable("last-input-event").unwrap_or(Value::Null);
            log(&out, format!("event {event:?}"));
            let Value::List(items) = &event else { return Ok(Value::Null) };
            match (items.get(1).and_then(Value::as_str), items.get(3)) {
                (Some("load-changed"), Some(status)) if status.as_str() == Some("load-finished") => {
                    let xw = items[2].clone();
                    let view = ed.xwidget_view_lookup(&xw, None)?;
                    log(&out, format!("view {:?}", view.map(|v| ed.xwidget_view_info(&v))));
                    ed.xwidget_webkit_execute_script(&xw, "[document.title, 6 * 7, {ok: true}]", Some(callback.clone()))?;
                }
                (Some("javascript-callback"), _) => {
                    let (function, value) = (items[3].clone(), items.get(4).cloned().unwrap_or(Value::Null));
                    ed.funcall(&function, &[value])?;
                }
                _ => {}
            }
            Ok(Value::Null)
        }),
    );
}

fn make(ed: &mut Editor, out: &str) {
    let result = (|| {
        let xw = ed.make_xwidget("webkit", Value::Str("smoke".into()), 400, 200, None, &Value::Null)?;
        ed.type_text("x\nbelow the web view\n");
        let spec = Value::List(vec![Value::Symbol("xwidget".into()), Value::Symbol(":xwidget".into()), xw.clone()]);
        ed.buffer_mut().put_text_property(0..1, "display", spec);
        ed.xwidget_webkit_goto_uri(&xw, "data:text/html,<title>Smoke</title><h1>Hello from a web view</h1>")
    })();
    log(out, format!("made {result:?}"));
}

impl eframe::App for Smoke {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.frames += 1;
        if self.frames == 10 {
            let out = std::env::args().nth(1).expect("an output file");
            self.app.run(move |ed| make(ed, &out));
        }
        // Closing the window would ask about the modified buffer.
        if self.start.elapsed() > Duration::from_secs(8) {
            std::process::exit(0);
        }
        ui.ctx().request_repaint_after(Duration::from_millis(50));
        eframe::App::ui(&mut self.app, ui, frame);
    }
}

fn main() -> eframe::Result {
    let out = std::env::args().nth(1).expect("an output file");
    let _ = std::fs::remove_file(&out);
    let options = eframe::NativeOptions { viewport: egui::ViewportBuilder::default().with_inner_size([700.0, 450.0]), ..Default::default() };
    eframe::run_native(
        "E8 xwidget smoke",
        options,
        Box::new(move |cc| {
            e8_gui::theme::install_fonts(&cc.egui_ctx, false);
            let app = E8App::threaded(&cc.egui_ctx, move |ed| {
                setup(ed, out);
                None
            });
            Ok(Box::new(Smoke { app, frames: 0, start: Instant::now() }))
        }),
    )
}
