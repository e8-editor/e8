//! Reading from the minibuffer partway through a command, as Emacs's
//! `read-from-minibuffer`, `completing-read` and `read-file-name` do; the
//! order completions are offered in, as `completion-all-sorted-completions`
//! keeps them; and what the minibuffer shows besides its input, which
//! icomplete fills.
//!
//! As with questions, the command waits for the answer, which the prompt
//! returns, the command loop running meanwhile (ADR 0053).

use crate::vfs as fs;
use std::path::Path;

use crate::command::{Arg, ParamKind};
use crate::completion;
use crate::editor::{Editor, Prompt};
use crate::error::{Error, Result};
use crate::files::{abbreviate_dir, expand_file_name};
use crate::buffer::Buffer;
use crate::variables::Value;

/// What a prompt opened partway through a command reads, and how.
#[derive(Clone, Debug)]
pub struct Reading {
    pub prompt: String,
    /// What it completes against, when `collection` is `None`.
    pub kind: ParamKind,
    /// The names to complete against, as `completing-read`'s collection.
    pub collection: Option<Vec<String>>,
    /// The completion category, as Emacs's completion metadata names it.
    pub category: Option<String>,
    /// Whether the answer must be one of the completions.
    pub require_match: bool,
    /// The input the minibuffer starts with.
    pub initial: Option<String>,
    /// What empty input stands for, and for a file name, input left as it
    /// started.
    pub default: Option<String>,
    /// The variable with earlier answers, if not the kind's.
    pub history: Option<String>,
    /// For a file name, the directory it starts in, if not the default one.
    pub dir: Option<String>,
    /// A function of the input that gives the names to complete against,
    /// called as the prompt opens and after each command, as Emacs's
    /// completion-table-dynamic makes a table from one.
    pub collection_fn: Option<crate::variables::Function>,
}

impl Reading {
    pub fn new(prompt: &str, kind: ParamKind) -> Reading {
        Reading {
            prompt: prompt.to_string(),
            kind,
            collection: None,
            collection_fn: None,
            category: None,
            require_match: false,
            initial: None,
            default: None,
            history: None,
            dir: None,
        }
    }
}

/// A prompt a recursive minibuffer opened inside, with what waits for its
/// answer, put back when the inner one closes.
pub(crate) struct OuterPrompt {
    prompt: Prompt,
    minibuffer: u64,
    pending_call: Option<crate::editor::PendingCall>,
    question: Option<crate::questions::Question>,
    window_selected: bool,
}

/// What the open prompt reads, for code that adapts to it, as icomplete does.
#[derive(Clone, Debug, PartialEq)]
pub struct MinibufferInfo {
    /// The prompt, such as `Find file: `.
    pub prompt: String,
    /// Whether it completes at all, as a non-nil `minibuffer-completion-table`.
    pub completing: bool,
    /// The completion category: file, buffer, command, variable or face for
    /// those kinds, or what a `completing-read` named.
    pub category: Option<String>,
    pub require_match: bool,
    pub default: Option<String>,
    /// The input the prompt started with, icomplete's `icomplete--initial-input`.
    pub initial: String,
    /// Whether completion ignores case here, as `completion-ignore-case` is
    /// bound for the prompt.
    pub ignore_case: bool,
    /// How many completions are kept for the input as it is.
    pub kept: usize,
    /// The variable the answer goes into, as `minibuffer-history-variable`.
    pub history: String,
}

impl Prompt {
    pub(crate) fn new(text: &str, kind: ParamKind, history: &str) -> Prompt {
        Prompt {
            text: text.to_string(),
            kind,
            history: history.to_string(),
            history_pos: 0,
            typed: String::new(),
            collection: None,
            category: None,
            require_match: matches!(kind, ParamKind::Command | ParamKind::Variable | ParamKind::Face),
            default: None,
            initial: String::new(),
            collection_fn: None,
            answer: None,
            sorted: None,
            serial: 0,
        }
    }

    fn completing(&self) -> bool {
        self.collection.is_some() || self.kind.completes()
    }

    fn category(&self) -> Option<String> {
        if self.collection.is_some() {
            return self.category.clone();
        }
        self.kind.completes().then(|| self.kind.name().to_string())
    }
}

impl Editor {
    /// Opens a prompt with `input` in the minibuffer, as Emacs's minibuffer
    /// does on entry: the minibuffer's own variables and keymaps are reset,
    /// a prompt that must be answered by a match gets
    /// `minibuffer-local-must-match-map`, and `minibuffer-setup-hook` runs.
    pub(crate) fn open_prompt(&mut self, mut prompt: Prompt, input: &str) {
        prompt.initial = input.to_string();
        self.keyboard.input_serial += 1;
        prompt.serial = self.keyboard.input_serial;
        let must_match = prompt.require_match;
        self.prompt = Some(prompt);
        self.current = self.minibuffer_index();
        self.minibuffer_window_selected = true;
        self.mini_window_lines = 1;
        // Its local map is minibuffer-local-map, and the must-match map
        // before it for a prompt that must be answered by a match.
        let must_match_map = self.keymap_named(MUST_MATCH_MAP).filter(|_| must_match);
        let local_map = must_match_map.into_iter().chain([self.minibuffer_map]).collect();
        let text = self.prompt.as_ref().map(|p| p.text.clone()).unwrap_or_default();
        let b = self.minibuffer_mut();
        b.locals.clear();
        b.local_hooks.clear();
        b.local_map = local_map;
        // The prompt is read-only text at the start, in a field of its own,
        // as minibuffer-prompt-properties make it; the input follows.
        b.set_text(&format!("{text}{input}"));
        let n = text.chars().count();
        if n > 0 {
            for (name, value) in [
                ("face", Value::Str("minibuffer-prompt".into())),
                ("read-only", Value::Bool(true)),
                ("field", Value::Symbol("prompt".into())),
                ("front-sticky", Value::Bool(true)),
                ("rear-nonsticky", Value::Bool(true)),
            ] {
                b.put_text_property(0..n, name, value);
            }
        }
        b.set_point(b.len());
        // A table that is a function gives its names before the setup hook
        // runs, so what the hook shows, as vertico's list, has them.
        self.refresh_dynamic_collection();
        if let Err(e) = self.run_hooks("minibuffer-setup-hook") {
            self.message(format!("Error in minibuffer-setup-hook: {e}"));
        }
    }

    /// Closes the open prompt, running `minibuffer-exit-hook` while it is
    /// still open, and returns it.
    pub(crate) fn close_prompt(&mut self) -> Option<Prompt> {
        self.prompt.as_ref()?;
        if let Err(e) = self.run_hooks("minibuffer-exit-hook") {
            self.message(format!("Error in minibuffer-exit-hook: {e}"));
        }
        let prompt = self.prompt.take();
        self.minibuffer_mut().set_text("");
        // What was current when it opened is again: the minibuffer it
        // opened inside, or the selected window's buffer.
        if self.buffers[self.current].id == self.minibuffer_id {
            let outer = self.outer_prompts.last().filter(|o| o.window_selected).and_then(|o| self.buffer_with_id(o.minibuffer));
            self.current = outer.unwrap_or_else(|| self.selected_buffer_index());
        }
        self.minibuffer_window_selected = false;
        prompt
    }

    /// Closes the prompt with `value` as its answer: it goes in the
    /// prompt's history and to the function or command waiting for it.
    pub(crate) fn finish_prompt(&mut self, value: String) -> Result<()> {
        let prompt = self.close_prompt().ok_or_else(|| Error::new("Not in the minibuffer"))?;
        self.add_to_history(&prompt.history, &value);
        match prompt.answer {
            Some(answer) => {
                answer.borrow_mut().get_or_insert(Ok(Value::Str(value)));
            }
            None => self.supply_arg(Arg::Str(value)),
        }
        self.resume_outer_minibuffer();
        Ok(())
    }

    /// Lets a prompt open while one is, in a minibuffer inside the open
    /// one, if `enable-recursive-minibuffers` is on, as in Emacs: the open
    /// prompt, and what waits for its answer, wait until the inner one is done.
    pub(crate) fn enter_recursive_minibuffer(&mut self) -> Result<()> {
        if self.prompt.is_none() {
            return Ok(());
        }
        if !self.variable("enable-recursive-minibuffers").is_some_and(|v| v.is_true()) {
            return Err(Error::new("Command attempted to use minibuffer while in minibuffer"));
        }
        let prompt = self.prompt.take().expect("checked above");
        self.outer_prompts.push(OuterPrompt {
            prompt,
            minibuffer: self.minibuffer_id,
            pending_call: self.pending_call.take(),
            question: self.question.take(),
            window_selected: self.minibuffer_window_selected,
        });
        let name = format!(" *Minibuf-{}*", self.outer_prompts.len() + 1);
        let index = self.get_buffer_create(&name);
        self.minibuffer_id = self.buffers[index].id;
        Ok(())
    }

    /// Puts back the prompt a recursive minibuffer opened inside, once the
    /// inner one is answered or quit and nothing more is being read for it.
    pub(crate) fn resume_outer_minibuffer(&mut self) {
        if self.prompt.is_some() || self.question.is_some() || self.pending_call.is_some() || self.keyboard.reading_keys.is_some() {
            return;
        }
        let Some(outer) = self.outer_prompts.pop() else { return };
        self.prompt = Some(outer.prompt);
        self.minibuffer_id = outer.minibuffer;
        self.pending_call = outer.pending_call;
        self.question = outer.question;
        self.minibuffer_window_selected = outer.window_selected;
        if self.running == 0 || self.minibuffer_window_selected {
            self.current_from_selected_window();
        }
    }

    /// How many minibuffers are open, one inside another, as Emacs's `minibuffer-depth`.
    pub fn minibuffer_depth(&self) -> usize {
        self.outer_prompts.len() + usize::from(self.prompt.is_some())
    }

    /// Whether the minibuffer's window is selected: while a prompt is open,
    /// unless `C-x o` selected another window.
    pub fn minibuffer_window_selected(&self) -> bool {
        self.prompt.is_some() && self.minibuffer_window_selected
    }

    /// Selects the minibuffer's window, while a prompt is open, as `C-x o`
    /// does coming back to it.
    pub fn select_minibuffer_window(&mut self) -> Result<()> {
        if self.prompt.is_none() {
            return Err(Error::new("Minibuffer window is not active"));
        }
        self.minibuffer_window_selected = true;
        self.current = self.minibuffer_index();
        Ok(())
    }

    /// Asks the open prompt's completion function for the names its input
    /// completes against now, if it has one.
    pub fn refresh_dynamic_collection(&mut self) {
        let Some(f) = self.prompt.as_ref().and_then(|p| p.collection_fn.clone()) else { return };
        let input = self.minibuffer_input();
        match f.call(self, &[Value::Str(input)]) {
            Ok(Value::List(items)) => {
                let names: Vec<String> = items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
                if let Some(prompt) = &mut self.prompt
                    && prompt.collection.as_ref() != Some(&names)
                {
                    // The sorted completions stay, as icomplete's rotation, unless the names changed.
                    prompt.collection = Some(names);
                    prompt.sorted = None;
                }
            }
            Ok(_) => {}
            Err(e) => self.message(format!("Error in completion function: {e}")),
        }
    }

    /// Reads an answer in the minibuffer and returns it, as Emacs's
    /// `read-from-minibuffer`, `completing-read` and `read-file-name` do,
    /// the command loop running meanwhile (ADR 0053).
    pub fn read_from_minibuffer(&mut self, reading: Reading) -> Result<Value> {
        let asker = self.resume_point();
        self.enter_recursive_minibuffer()?;
        let history = reading.history.clone().unwrap_or_else(|| reading.kind.history().to_string());
        let mut prompt = Prompt::new(&reading.prompt, reading.kind, &history);
        prompt.require_match |= reading.require_match;
        prompt.collection = reading.collection.or_else(|| reading.collection_fn.as_ref().map(|_| Vec::new()));
        prompt.collection_fn = reading.collection_fn;
        prompt.category = reading.category;
        prompt.default = reading.default;
        let answer = crate::editor::AnswerSlot::default();
        prompt.answer = Some(answer.clone());
        let input = match (reading.initial, reading.kind) {
            (Some(initial), _) => initial,
            (None, ParamKind::File) => match &reading.dir {
                Some(dir) => abbreviate_dir(&expand_file_name(dir)),
                None => abbreviate_dir(&self.default_directory()),
            },
            (None, _) => String::new(),
        };
        self.open_prompt(prompt, &input);
        self.wait_for_answer(&asker, &answer)
    }

    /// What the open prompt reads, or `None` if none is open.
    pub fn minibuffer_info(&self) -> Option<MinibufferInfo> {
        let p = self.prompt.as_ref()?;
        Some(MinibufferInfo {
            prompt: p.text.clone(),
            completing: p.completing() && self.question.is_none(),
            category: p.category(),
            require_match: p.require_match,
            default: p.default.clone(),
            initial: p.initial.clone(),
            ignore_case: self.completion_ignore_case(),
            kept: self.kept_completions(),
            history: p.history.clone(),
        })
    }

    /// The minibuffer's input.
    pub fn minibuffer_input(&self) -> String {
        let mb = self.minibuffer();
        mb.slice(self.minibuffer_prompt_end()..mb.len())
    }

    /// Where the prompt ends and the input starts, as Emacs's
    /// `minibuffer-prompt-end`: after the text whose field is `prompt`.
    pub fn minibuffer_prompt_end(&self) -> usize {
        let mb = self.minibuffer();
        let in_prompt = |pos| mb.text_properties_at(pos).and_then(|p| p.get("field")).and_then(Value::as_str) == Some("prompt");
        (0..mb.len()).find(|&pos| !in_prompt(pos)).unwrap_or(mb.len())
    }

    /// Point in the minibuffer as a place in the input.
    pub fn minibuffer_input_point(&self) -> usize {
        self.minibuffer().point().saturating_sub(self.minibuffer_prompt_end())
    }

    /// Replaces the input, the prompt left alone, with point `point`
    /// characters into it, as the history and completion commands do.
    pub(crate) fn replace_minibuffer_input(&mut self, text: &str, point: usize) {
        let index = self.minibuffer_index();
        let start = self.minibuffer_prompt_end();
        self.with_current_buffer(index, |ed| {
            let end = ed.buffer().len();
            if ed.buffer().slice(start..end) != text
                && let Err(e) = ed.delete_region(start, end).and_then(|_| {
                    ed.buffer_mut().set_point(start);
                    ed.insert(text)
                })
            {
                ed.message(e.to_string());
            }
            let end = ed.buffer().len();
            ed.buffer_mut().set_point((start + point).min(end));
        });
    }

    /// Keeps point out of the prompt, as Emacs's cursor-intangible-mode
    /// does in the minibuffer after each command.
    pub(crate) fn keep_point_out_of_prompt(&mut self) {
        if self.in_minibuffer() {
            let end = self.minibuffer_prompt_end();
            if self.buffer().point() < end {
                self.buffer_mut().set_point(end);
            }
        }
    }

    /// Replaces the open prompt's input, with point at its end, as an agent
    /// or a test answering it might.
    pub fn set_minibuffer_input(&mut self, text: &str) {
        if self.prompt.is_some() {
            self.replace_minibuffer_input(text, text.chars().count());
        }
    }

    /// What the input completes against, split as Emacs's completion
    /// boundaries split it: the part completion leaves alone, such as a file
    /// name's directory; the part that completes, before and after point;
    /// what follows it, such as the rest of a file name after the next
    /// slash; and the names the part could complete to.
    fn completion_table(&self, prompt: &Prompt, input: &str, point: usize) -> Field {
        let at = input.char_indices().nth(point).map_or(input.len(), |(i, _)| i);
        let (before, after) = input.split_at(at);
        let names = match (prompt.collection.as_ref(), prompt.kind) {
            (Some(collection), _) => collection.clone(),
            (None, ParamKind::File) => {
                let (base, before) = before.rfind('/').map_or(("", before), |i| before.split_at(i + 1));
                let (after, suffix) = after.find('/').map_or((after, ""), |i| after.split_at(i));
                let dir = if base.is_empty() { self.default_directory() } else { expand_file_name(base) };
                return Field {
                    base: base.to_string(),
                    before: before.to_string(),
                    after: after.to_string(),
                    suffix: suffix.to_string(),
                    names: file_name_all_completions(&dir),
                };
            }
            (None, ParamKind::Command) => self.command_names().map(str::to_string).collect(),
            // As Emacs's internal-complete-buffer, buffers whose names start
            // with a space only for input that does.
            (None, ParamKind::Buffer) => self
                .buffers
                .iter()
                .map(|b| b.name.clone())
                .filter(|n| !n.starts_with(' ') || input.starts_with(' '))
                .collect(),
            (None, ParamKind::Variable) => self.variables().map(|v| v.name.clone()).collect(),
            (None, ParamKind::Face) => self.faces.keys().cloned().collect(),
            (None, _) => Vec::new(),
        };
        Field { base: String::new(), before: before.to_string(), after: after.to_string(), suffix: String::new(), names }
    }

    /// What the open prompt's input completes against with point at
    /// `point`, as scripts that complete for themselves, such as vertico,
    /// need it: the part completion leaves alone, the part before and after
    /// point that completes, what follows that, and the names.
    pub fn minibuffer_completion_field(&self, point: usize) -> Option<(String, String, String, String, Vec<String>)> {
        let prompt = self.prompt.as_ref().filter(|p| p.completing())?;
        let f = self.completion_table(prompt, &self.minibuffer_input(), point);
        Some((f.base, f.before, f.after, f.suffix, f.names))
    }

    /// Whether `input` is an answer the open prompt takes, as Emacs's
    /// `test-completion`.
    pub fn test_completion(&self, input: &str) -> bool {
        self.is_completion_match(input)
    }

    /// Whether completion ignores case, as Emacs binds `completion-ignore-case`
    /// for file and buffer names to `read-file-name-completion-ignore-case`
    /// and `read-buffer-completion-ignore-case`.
    pub(crate) fn completion_ignore_case(&self) -> bool {
        let variable = match self.prompt.as_ref().filter(|p| p.collection.is_none()).map(|p| p.kind) {
            Some(ParamKind::File) => "read-file-name-completion-ignore-case",
            Some(ParamKind::Buffer) => "read-buffer-completion-ignore-case",
            _ => "completion-ignore-case",
        };
        self.variable(variable).is_some_and(|v| v.is_true()) || self.variable("completion-ignore-case").is_some_and(|v| v.is_true())
    }

    /// The open prompt's completions for `input` with point at its end,
    /// whole, in alphabetical order.
    pub(crate) fn prompt_completions(&self, input: &str) -> Vec<String> {
        let Some(prompt) = &self.prompt else { return Vec::new() };
        let field = self.completion_table(prompt, input, input.chars().count());
        let fold = self.completion_ignore_case();
        let (_, mut found) = completion::all_completions(&self.completion_styles(), &field.before, &field.after, &field.names, fold);
        found.sort();
        found.dedup();
        found.into_iter().map(|c| format!("{}{c}", field.base)).collect()
    }

    /// What completing the minibuffer's input as far as it goes gives, as
    /// Emacs's `completion-try-completion`: the new input and where point
    /// goes in it.
    pub(crate) fn completion_try(&self) -> completion::Try {
        self.completion_try_with(&self.minibuffer_input(), self.minibuffer_input_point(), None)
    }

    /// What completing `input` with point at `point` gives, against `names`
    /// if given, else against what the open prompt completes, as Emacs's
    /// `completion-try-completion` with a table.
    pub fn completion_try_with(&self, input: &str, point: usize, names: Option<Vec<String>>) -> completion::Try {
        let Some(prompt) = &self.prompt else { return completion::Try::None };
        let mut field = self.completion_table(prompt, input, point);
        if let Some(names) = names {
            let at = input.char_indices().nth(point).map_or(input.len(), |(i, _)| i);
            field = Field { base: String::new(), before: input[..at].into(), after: input[at..].into(), suffix: String::new(), names };
        }
        let ignored = (prompt.kind == ParamKind::File && prompt.collection.is_none()).then(|| self.string_list("completion-ignored-extensions"));
        let result = completion::try_completion(
            &self.completion_styles(),
            &field.before,
            &field.after,
            &field.suffix,
            &field.names,
            self.completion_ignore_case(),
            ignored.as_deref(),
        );
        match result {
            completion::Try::Completed { text, point } => {
                completion::Try::Completed { point: field.base.chars().count() + point, text: format!("{}{text}", field.base) }
            }
            other => other,
        }
    }

    /// Whether `input` is itself a valid answer to the open prompt, as
    /// Emacs's `test-completion`.
    pub(crate) fn is_completion_match(&self, input: &str) -> bool {
        let Some(prompt) = &self.prompt else { return false };
        if prompt.kind == ParamKind::File && prompt.collection.is_none() {
            return fs::path_exists(expand_file_name(input));
        }
        let field = self.completion_table(prompt, input, input.chars().count());
        let fold = self.completion_ignore_case();
        field.names.iter().any(|n| if fold { n.to_lowercase() == field.before.to_lowercase() } else { *n == field.before })
    }

    /// The open prompt's completions, in the order Emacs's
    /// `completion-all-sorted-completions` offers them, and the part of the
    /// input before them, such as a file name's directory. They are kept
    /// until the input changes, so commands can rotate them, as icomplete's
    /// do, with [`Editor::cache_all_sorted_completions`].
    ///
    /// Names come shortest first, then alphabetically, and then those in the
    /// prompt's history first, most recent first, with the default before
    /// them. Matched by the flex style, they come best match first instead,
    /// as Emacs's `completion--flex-adjust-metadata` sorts them, and equals
    /// in the table's order: a collection's, or a directory's as the system
    /// lists it.
    pub fn completion_all_sorted_completions(&mut self) -> Option<(String, Vec<String>)> {
        self.completion_all_sorted_completions_at(self.minibuffer_input_point()).map(|(base, comps, _)| (base, comps))
    }

    /// As [`Editor::completion_all_sorted_completions`], as if point were
    /// at `point`, as icomplete puts it at the end of the input to show them,
    /// and whether they were sorted now rather than kept.
    pub fn completion_all_sorted_completions_at(&mut self, point: usize) -> Option<(String, Vec<String>, bool)> {
        let input = self.minibuffer_input();
        let prompt = self.prompt.as_ref()?;
        if !prompt.completing() {
            return None;
        }
        // As in Emacs, where the kept list is a variable, none kept is no list.
        if let Some((cached, base, comps)) = &prompt.sorted
            && *cached == input
            && !comps.is_empty()
        {
            return Some((base.clone(), comps.clone(), false));
        }
        let field = self.completion_table(prompt, &input, point);
        let (base, name) = (field.base.clone(), format!("{}{}", field.before, field.after));
        let fold = self.completion_ignore_case();
        let (style, found) = completion::all_completions(&self.completion_styles(), &field.before, &field.after, &field.names, fold);
        // In the table's order, which flex matches keep among equals.
        let mut comps: Vec<String> = Vec::new();
        for c in found {
            if !comps.contains(&c) {
                comps.push(c);
            }
        }
        let table_order = comps.clone();
        let history: Vec<String> = prompt
            .default
            .iter()
            .cloned()
            .chain(self.string_list(&prompt.history))
            .filter_map(|h| h.strip_prefix(base.as_str()).map(str::to_string))
            .collect();
        if style.as_deref() == Some("flex") && !name.is_empty() {
            let score = |c: &String| completion::flex_score(&name, c, fold);
            comps = table_order;
            comps.sort_by(|a, b| score(b).total_cmp(&score(a)));
        } else {
            completion::sort_completions(&mut comps, &history);
        }
        let prompt = self.prompt.as_mut().expect("checked above");
        prompt.sorted = Some((input, base.clone(), comps.clone()));
        Some((base, comps, true))
    }

    /// Replaces the kept completions, in a new order or with some left out,
    /// as Emacs's `completion--cache-all-sorted-completions`. They are kept
    /// until the input changes.
    pub fn cache_all_sorted_completions(&mut self, comps: Vec<String>) {
        let input = self.minibuffer_input();
        let Some(prompt) = self.prompt.as_mut() else { return };
        let base = prompt.sorted.take().map(|(_, base, _)| base).unwrap_or_default();
        prompt.sorted = Some((input, base, comps));
    }

    /// Forgets the kept completions, so they are sorted again, as Emacs's
    /// `completion--flush-all-sorted-completions`.
    pub(crate) fn flush_all_sorted_completions(&mut self) {
        if let Some(prompt) = self.prompt.as_mut() {
            prompt.sorted = None;
        }
    }

    /// How many completions are kept for the input as it is, as Emacs's
    /// `(safe-length completion-all-sorted-completions)`.
    pub fn kept_completions(&self) -> usize {
        let input = self.minibuffer_input();
        match self.prompt.as_ref().and_then(|p| p.sorted.as_ref()) {
            Some((cached, _, comps)) if *cached == input => comps.len(),
            _ => 0,
        }
    }

    /// Completes the input to the first of the sorted completions, as
    /// Emacs's `minibuffer-force-complete` does without cycling. Returns
    /// false if there are none.
    pub(crate) fn force_complete(&mut self) -> bool {
        let Some((base, comps)) = self.completion_all_sorted_completions() else { return false };
        let Some(first) = comps.first() else { return false };
        let text = format!("{base}{first}");
        self.replace_minibuffer_input(&text, text.chars().count());
        true
    }

    fn string_list(&self, variable: &str) -> Vec<String> {
        match self.variable(variable) {
            Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        }
    }

    /// The first key sequence that runs a command in the window's buffer, as
    /// Emacs's `where-is-internal` with FIRSTONLY: in its modes' keymaps
    /// first, then the global map.
    pub fn where_is(&self, command: &str) -> Option<Vec<crate::key::Key>> {
        let b = self.window_buffer();
        let mut maps = self.mode_keymaps_in(b, false);
        maps.push(self.global_map());
        let found = maps.iter().flat_map(|&m| self.keymaps().keys_for(m, command));
        found.into_iter().find(|keys| self.lookup_keys_in_window_buffer(keys) == command)
    }

    /// Every key sequence that runs a command in the window's buffer, as
    /// `where-is-internal` without FIRSTONLY: the modes' keymaps' first,
    /// then the global map's, each once, and none that another shadows.
    pub fn where_is_all(&self, command: &str) -> Vec<Vec<crate::key::Key>> {
        let b = self.window_buffer();
        let mut maps = self.mode_keymaps_in(b, false);
        maps.push(self.global_map());
        let mut out: Vec<Vec<crate::key::Key>> = Vec::new();
        for keys in maps.iter().flat_map(|&m| self.keymaps().keys_for(m, command)) {
            if !out.contains(&keys) && self.lookup_keys_in_window_buffer(&keys) == command {
                out.push(keys);
            }
        }
        out
    }

    /// What a key sequence runs in the window's buffer, ignoring any prompt.
    fn lookup_keys_in_window_buffer(&self, keys: &[crate::key::Key]) -> String {
        let b = self.window_buffer();
        let mut maps = self.mode_keymaps_in(b, false);
        maps.push(self.global_map());
        for map in maps {
            if let crate::keymap::Lookup::Command(c) = self.lookup_in(map, keys) {
                return c;
            }
        }
        String::new()
    }

    /// What overlays show in the minibuffer before its prompt and after its
    /// input, as text: their before-strings at its start and after-strings
    /// at its end, as icomplete shows its count and list.
    pub fn minibuffer_strings(&self) -> (String, String) {
        let mb = self.minibuffer();
        let end = mb.len();
        let mut overlays: Vec<&crate::properties::Overlay> = mb.overlays().collect();
        overlays.sort_by(|a, b| a.priority().total_cmp(&b.priority()).then(a.id.cmp(&b.id)));
        let strings = |at: usize, name: &str| -> String {
            overlays
                .iter()
                .filter(|o| if name == "before-string" { o.start == at } else { o.end == at })
                .filter_map(|o| o.props.get(name).and_then(Value::as_str).map(str::to_string))
                .collect()
        };
        (strings(0, "before-string"), strings(end, "after-string"))
    }

    /// The rows the echo area shows while a prompt is open: the
    /// minibuffer's text, prompt and input, with its faces and its overlays'
    /// strings, as any window shows its buffer, and a message shown meanwhile
    /// after the input, before what overlays add at its end, as Emacs's
    /// minibuffer-message shows it.
    pub fn minibuffer_rows(&self, dark: bool) -> Vec<crate::Row> {
        let mb = self.minibuffer();
        // Long input continues on the next line, as a window's lines do, and
        // the echo area grows to show it, as resize-mini-windows says.
        let width = self.minibuffer_width.unwrap_or_else(|| self.frame_cells().0);
        let wrap = (!self.variable_in(mb, "truncate-lines").is_some_and(|v| v.is_true()))
            .then(|| crate::rows::Wrap { width: width.saturating_sub(usize::from(!self.metrics.fringes())).max(1), words: false });
        let mut rows = self.rows_in(mb, 0, 1000, dark, wrap);
        if let Some(message) = self.echo() {
            let end = mb.len();
            let style = self.style_for(&["shadow".to_string()], dark);
            let segment = crate::rows::Segment { string: true, ..crate::rows::Segment::text(end, format!(" {message}"), style) };
            if let Some(row) = rows.iter_mut().find(|r| r.shows_point(end)) {
                let at = row.segments.iter().position(|s| s.string && s.start == end).unwrap_or(row.segments.len());
                row.segments.insert(at, segment);
            }
        }
        rows
    }

    /// Tells the editor how many columns the minibuffer's window is wide,
    /// where its long lines wrap.
    pub fn set_minibuffer_width(&mut self, columns: usize) {
        self.minibuffer_width = Some(columns.max(1));
    }

    /// The buffer whose values size the echo area: the minibuffer's while a
    /// prompt is open, as a completion UI such as vertico sets
    /// `max-mini-window-height` there, else the selected window's.
    fn mini_window_buffer(&self) -> &Buffer {
        if self.prompt.is_some() { self.minibuffer() } else { self.window_buffer() }
    }

    /// The frame's height in lines with the echo area, as the front end
    /// last gave it to [`Editor::mini_window_height`].
    pub fn frame_lines(&self) -> usize {
        self.frame_lines.unwrap_or_else(|| self.frame_cells().1 + self.mini_window_lines())
    }

    /// The most lines the minibuffer may take in a frame of `frame_lines`
    /// lines, as `max-mini-window-height` says: a fraction of the frame, up
    /// to 1, or a number of lines.
    pub fn max_mini_window_lines(&self, frame_lines: usize) -> usize {
        let max = self.number_in(self.mini_window_buffer(), "max-mini-window-height", 0.25);
        // Emacs takes a float as a fraction and an integer as lines; E8's
        // numbers cannot tell 1.0 from 1, so 1 is the whole frame, as
        // vertico's 1.0 means it.
        let lines = if max <= 1.0 { (max * frame_lines as f64).floor() } else { max.floor() };
        (lines as usize).max(1)
    }

    /// How many lines the echo area takes now, as [`Editor::mini_window_height`]
    /// last worked out.
    pub fn mini_window_lines(&self) -> usize {
        if self.prompt.is_some() { self.mini_window_lines } else { self.echo_area_lines.max(1) }
    }

    /// The echo area's message as the lines it shows: each of its lines,
    /// broken where it passes the minibuffer's width, as Emacs shows a long
    /// message on as many lines as it takes.
    pub fn echo_lines(&self) -> Vec<String> {
        let Some(message) = self.echo() else { return Vec::new() };
        let width = self.minibuffer_width.unwrap_or_else(|| self.frame_cells().0).max(1);
        let mut lines = Vec::new();
        for text in message.split('\n') {
            let (mut line, mut col) = (String::new(), 0);
            let mut scratch = String::new();
            for c in text.chars() {
                scratch.clear();
                let w = crate::display::render_char(c, col, 8, &mut scratch);
                if col + w > width && col > 0 {
                    lines.push(std::mem::take(&mut line));
                    col = 0;
                    scratch.clear();
                    let w = crate::display::render_char(c, 0, 8, &mut scratch);
                    line.push_str(&scratch);
                    col += w;
                    continue;
                }
                line.push_str(&scratch);
                col += w;
            }
            lines.push(line);
        }
        lines
    }

    /// How many lines the echo area takes in a frame of `frame_lines` lines,
    /// counting it: enough for the minibuffer's overlay, up to
    /// `max-mini-window-height`, and while a prompt is open never fewer
    /// than it has taken, as `resize-mini-windows`' grow-only says.
    pub fn mini_window_height(&mut self, frame_lines: usize) -> usize {
        self.frame_lines = Some(frame_lines);
        let limit = |ed: &Self, wanted: usize| wanted.min(ed.max_mini_window_lines(frame_lines)).min(frame_lines.saturating_sub(2).max(1));
        if self.prompt.is_none() {
            self.mini_window_lines = 1;
            // A long message takes as many lines as it needs, and the echo
            // area shrinks again once it goes.
            self.echo_area_lines = limit(self, self.echo_lines().len().max(1));
            return self.echo_area_lines;
        }
        let rows = self.minibuffer_rows(true);
        // An empty last line after an overlay string's newline, as ends
        // vertico's last candidate, takes no line, as Emacs's
        // resize_mini_window finds it has no height; one the input ends
        // with holds the cursor, and does.
        let empty_last = rows.len() > 1
            && rows.last().is_some_and(|r| r.segments.iter().all(|s| s.text.is_empty()))
            && rows[rows.len() - 2].segments.last().is_some_and(|s| s.string);
        let wanted = (rows.len() - usize::from(empty_last)).max(1);
        let wanted = wanted.min(self.max_mini_window_lines(frame_lines)).min(frame_lines.saturating_sub(2).max(1));
        let grow_only = !matches!(self.variable_in(self.mini_window_buffer(), "resize-mini-windows"), Some(Value::Bool(true)));
        self.mini_window_lines = if grow_only { self.mini_window_lines.max(wanted) } else { wanted };
        self.mini_window_lines
    }
}

/// The minibuffer's input as completion splits it.
struct Field {
    base: String,
    before: String,
    after: String,
    suffix: String,
    names: Vec<String>,
}

/// The keymap of prompts that must be answered by one of their completions,
/// as Emacs's: RET completes before it exits.
pub(crate) const MUST_MATCH_MAP: &str = "minibuffer-local-must-match-map";

/// The names a directory's entries complete to, as Emacs's
/// `file-name-all-completions` gives them: every entry, directories with a
/// slash, and `./` and `../`, in the reverse of the order the system lists
/// them in, which is how Emacs collects them.
pub fn file_name_all_completions(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if fs::path_is_dir(e.path()) { format!("{name}/") } else { name }
        })
        .collect();
    out.reverse();
    out.extend(["../".to_string(), "./".to_string()]);
    out
}
