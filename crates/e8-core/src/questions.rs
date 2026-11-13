//! Questions a command asks partway through, as Emacs's `yes-or-no-p`,
//! `y-or-n-p` and `read-char-choice`.
//!
//! As in Emacs, the command waits for the answer, which the question
//! returns: the editor runs its command loop meanwhile (ADR 0053). The
//! question opens the minibuffer as a prompt does, so front ends show it,
//! `C-g` quits it, and the agent and tests see an open prompt to answer.

use crate::command::ParamKind;
use crate::editor::{AnswerSlot, Editor, Prompt};
use crate::error::Result;
use crate::key::{Key, KeyCode};
use crate::variables::Value;

pub(crate) struct Question {
    /// The question without what it says about answering.
    text: String,
    /// The keys that answer it, or `None` for an answer typed out.
    chars: Option<Vec<char>>,
    /// The answers that can be typed out, for a question not read by key.
    answers: Vec<String>,
    /// What the full prompt adds after the question, such as `(y or n) `.
    choices: String,
    /// Where the answer goes, for the command waiting on it.
    pub(crate) answer: AnswerSlot,
}

impl Editor {
    /// Asks a question answered by typing "yes" or "no" and RET, as Emacs's
    /// `yes-or-no-p`, and returns whether the answer was yes.
    pub fn yes_or_no_p(&mut self, question: &str) -> Result<bool> {
        if self.use_dialog_box_p() {
            return self.ask_in_dialog(question);
        }
        // As Emacs 28's use-short-answers: y or n will do.
        if self.variable("use-short-answers").is_some_and(|v| v.is_true()) {
            return self.y_or_n_p(question);
        }
        Ok(self.read_answer(question, &["yes", "no"])? == "yes")
    }

    /// Asks a yes or no question in a dialog, as subr.el's `y-or-n-p` and
    /// `yes-or-no-p` ask with `x-popup-dialog` when `use-dialog-box-p`
    /// says the mouse or a menu asked.
    fn ask_in_dialog(&mut self, question: &str) -> Result<bool> {
        let contents = vec![
            crate::variables::Value::Str(question.to_string()),
            crate::variables::Value::List(vec![crate::variables::Value::Str("Yes".into()), crate::variables::Value::Bool(true)]),
            crate::variables::Value::List(vec![crate::variables::Value::Str("No".into()), crate::variables::Value::Bool(false)]),
        ];
        Ok(self.x_popup_dialog(&contents)?.is_true())
    }

    /// Asks a question answered by typing one of `answers` and RET, as
    /// Emacs's `read-answer` and the long form of `read-multiple-choice`,
    /// and returns the answer.
    pub fn read_answer(&mut self, question: &str, answers: &[&str]) -> Result<String> {
        let choices = match answers {
            [a, b] => format!("({a} or {b}) "),
            _ => format!("({}) ", answers.join(", ")),
        };
        let answers = answers.iter().map(|a| a.to_string()).collect();
        self.ask(question, None, answers, choices)
    }

    /// Asks a question answered by typing y or n, as Emacs's `y-or-n-p`,
    /// and returns whether the answer was y.
    pub fn y_or_n_p(&mut self, question: &str) -> Result<bool> {
        if self.use_dialog_box_p() {
            return self.ask_in_dialog(question);
        }
        Ok(self.ask(question, Some(vec!['y', 'n']), Vec::new(), "(y or n) ".into())? == "y")
    }

    /// Asks a question answered by one of `chars`, as Emacs's
    /// `read-char-choice`; the prompt says what the choices are. Returns
    /// the character typed, as a string.
    pub fn read_char_choice(&mut self, prompt: &str, chars: &[char]) -> Result<String> {
        self.ask(prompt, Some(chars.to_vec()), Vec::new(), String::new())
    }

    /// Whether the open prompt is a question answered by a single key.
    pub fn prompt_reads_char(&self) -> bool {
        self.question.as_ref().is_some_and(|q| q.chars.is_some())
    }

    /// Asks a question and waits for its answer.
    fn ask(&mut self, text: &str, chars: Option<Vec<char>>, answers: Vec<String>, choices: String) -> Result<String> {
        let asker = self.resume_point();
        self.enter_recursive_minibuffer()?;
        let answer = AnswerSlot::default();
        self.open_question(Question { text: text.to_string(), chars, answers, choices, answer: answer.clone() }, "");
        let value = self.wait_for_answer(&asker, &answer)?;
        Ok(value.as_str().unwrap_or_default().to_string())
    }

    fn open_question(&mut self, question: Question, preface: &str) {
        let history = if question.chars.is_some() { "read-char-history" } else { "yes-or-no-p-history" };
        let text = format!("{preface}{}{}", question.text, question.choices);
        self.question = Some(question);
        self.open_prompt(Prompt::new(&text, ParamKind::String, history), "");
    }

    /// Answers a question with what was typed. Anything but one of its
    /// answers asks again, as Emacs does.
    pub(crate) fn answer_typed(&mut self, answer: &str) -> bool {
        let Some(question) = self.question.take() else { return false };
        if question.answers.iter().any(|a| a == answer) {
            self.run_answer(&question, Value::Str(answer.to_string()));
        } else {
            let answers = match question.answers.as_slice() {
                [rest @ .., last] if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
                all => all.join(""),
            };
            self.message(format!("Please answer {answers}."));
            self.open_question(question, "");
        }
        true
    }

    /// Answers a question read by a single key. Returns false if no such
    /// question is open, or for `C-g`, which quits it as a prompt.
    pub(crate) fn answer_key(&mut self, key: Key) -> bool {
        let Some(chars) = self.question.as_ref().and_then(|q| q.chars.clone()) else { return false };
        if key == Key::parse("C-g").expect("C-g parses") {
            return false;
        }
        let typed = match key {
            Key { code: KeyCode::Char(c), ctrl: false, meta: false, .. } => Some(c),
            _ => None,
        };
        let question = self.question.take().expect("checked above");
        match typed.filter(|c| chars.contains(c)) {
            Some(c) => {
                self.close_prompt();
                self.run_answer(&question, Value::Str(c.to_string()));
            }
            None => {
                let preface = match chars.as_slice() {
                    ['y', 'n'] => "Please answer y or n.  ",
                    _ => "",
                };
                self.close_prompt();
                self.open_question(question, preface);
            }
        }
        true
    }

    /// Gives the waiting command a question's answer.
    fn run_answer(&mut self, question: &Question, answer: Value) {
        question.answer.borrow_mut().get_or_insert(Ok(answer));
    }

    /// Forgets any open question, as `C-g` does, and returns it.
    pub(crate) fn drop_question(&mut self) -> Option<Question> {
        self.question.take()
    }
}
