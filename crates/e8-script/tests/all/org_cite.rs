//! Org Cite (oc.ts) and its basic processor (oc-basic.ts) in the buffer:
//! inserting and editing citations with C-c C-x @, following a key to its
//! entry with C-c C-o, and fontifying citations. Each expected result is
//! what Org 9.7 in Emacs 30.2 does with the same text and bibliography.
//! Export is compared with Emacs by the oracle (tests/emacs/cases/org-cite.json).

use e8_core::{Arg, Editor};
use e8_script::Scripting;

const BIB: &str = "@string{pub = \"Free Press\"}

@book{knuth84,
  author    = {Knuth, Donald E.},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = 1984
}

@book{lamport94b,
  author    = {Lamport, Leslie and Smith, John},
  title     = {More Things},
  publisher = pub,
  date      = {1994-05-01}
}

@misc{org,
  editor = {Org Team},
  title  = {The Org Manual},
  institution = {GNU} # { Project},
  year   = 2021
}
";

const JSON: &str = "[
  {
    \"id\": \"dominik10\",
    \"author\": [{\"family\": \"Dominik\", \"given\": \"Carsten\"}],
    \"title\": \"The Org Mode 7 Reference Manual\"
  },
  {
    \"id\": \"stallman\",
    \"author\": [{\"family\": \"Stallman\", \"given\": \"Richard\"}],
    \"title\": \"EMACS: The Extensible Editor\"
  }
]
";

/// Text the citations work on comes after this line.
const HEADER: &str = "#+bibliography: refs.bib\n";

struct Cite {
    ed: Editor,
    s: Scripting,
    dir: tempfile::TempDir,
}

/// An editor visiting doc.org, holding HEADER and TEXT, beside refs.bib and refs.json.
fn cite(text: &str) -> Cite {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("refs.bib"), BIB).unwrap();
    std::fs::write(dir.path().join("refs.json"), JSON).unwrap();
    let path = dir.path().join("doc.org");
    std::fs::write(&path, format!("{HEADER}{text}")).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    Cite { ed, s, dir }
}

impl Cite {
    fn eval(&mut self, expression: &str) -> String {
        self.s.eval_expression(&mut self.ed, expression).unwrap()
    }

    /// The text after HEADER.
    fn text(&self) -> String {
        let b = self.ed.window_buffer();
        b.slice(HEADER.len()..b.len())
    }

    /// Point, counted from the end of HEADER.
    fn point(&self) -> usize {
        self.ed.window_buffer().point() - HEADER.len()
    }

    fn goto(&mut self, pos: usize) {
        self.eval(&format!("e8.gotoChar({})", HEADER.len() + pos));
    }
}

/// Keys typing TEXT.
fn typed(text: &str) -> String {
    text.chars().map(|c| if c == ' ' { "SPC".to_string() } else { c.to_string() }).collect::<Vec<_>>().join(" ")
}

#[test]
fn a_citation_is_inserted_from_the_keys_chosen() {
    let mut t = cite("Text  here.\n");
    t.goto(5);
    t.ed.press(&format!("C-c C-x @ {} TAB RET RET", typed("Knuth"))).unwrap();
    assert_eq!(t.text(), "Text [cite:@knuth84] here.\n");
    assert_eq!(t.point(), 20);
}

/// Keys chosen one after another go in the citation last first, as Org
/// pushes each onto its list.
#[test]
fn keys_chosen_in_turn_go_in_last_first() {
    let mut t = cite("Text  here.\n");
    t.goto(5);
    t.ed.press(&format!("C-c C-x @ {} TAB RET {} TAB RET RET", typed("Knuth"), typed("Org"))).unwrap();
    assert_eq!(t.text(), "Text [cite:@org; @knuth84] here.\n");
    assert_eq!(t.point(), 26);
}

/// On a key, the key chosen replaces it; just before its @, it goes
/// before it; on the style, the style is replaced.
#[test]
fn a_citation_is_edited_where_point_is() {
    let mut t = cite("See [cite:@knuth84;@org] now.\n");
    t.goto(13);
    t.ed.press(&format!("C-c C-x @ {} TAB RET", typed("Org"))).unwrap();
    assert_eq!(t.text(), "See [cite:@org;@org] now.\n");
    assert_eq!(t.point(), 10);
    let mut t = cite("See [cite:@knuth84;@org] now.\n");
    t.goto(10);
    t.ed.press(&format!("C-c C-x @ {} TAB RET", typed("Org"))).unwrap();
    assert_eq!(t.text(), "See [cite:@org;@knuth84;@org] now.\n");
    let mut t = cite("See [cite/t:@knuth84] now.\n");
    t.goto(7);
    t.ed.press(&format!("C-c C-x @ {} RET", typed("noauthor"))).unwrap();
    assert_eq!(t.text(), "See [cite/noauthor:@knuth84] now.\n");
}

/// With C-u, the reference at point is deleted, and the citation with its last reference.
#[test]
fn a_prefix_argument_deletes_the_reference() {
    let mut t = cite("See [cite:@knuth84;@org] now.\n");
    t.goto(13);
    t.ed.press("C-u C-c C-x @").unwrap();
    assert_eq!(t.text(), "See [cite:@org] now.\n");
    t.goto(13);
    t.ed.press("C-u C-c C-x @").unwrap();
    assert_eq!(t.text(), "See now.\n");
}

/// Not in a source block; on a heading, within its title.
#[test]
fn citations_go_only_where_org_allows_them() {
    let mut t = cite("#+begin_src emacs-lisp\n(x)\n#+end_src\n");
    t.goto(26);
    t.ed.press("C-c C-x @").unwrap();
    assert_eq!(t.ed.messages().last().map(String::as_str), Some("Cannot insert a citation here"));
    assert_eq!(t.text(), "#+begin_src emacs-lisp\n(x)\n#+end_src\n");
    let mut t = cite("* Heading :tag:\n");
    t.goto(4);
    t.ed.press(&format!("C-c C-x @ {} TAB RET RET", typed("Knuth"))).unwrap();
    assert_eq!(t.text(), "* He[cite:@knuth84]ading :tag:\n");
}

/// C-c C-o on a key visits its bibliography's file at the entry: a
/// BibTeX entry's @, a CSL-JSON item's brace.
#[test]
fn following_a_key_visits_its_entry() {
    let mut t = cite("#+bibliography: refs.json\nSee [cite:@lamport94b] and [cite:@stallman].\n");
    t.goto(37);
    t.ed.press("C-c C-o").unwrap();
    assert_eq!(t.ed.window_buffer().name, "refs.bib");
    let at = BIB.find("@book{lamport94b").unwrap();
    assert_eq!(t.ed.window_buffer().point(), at);
    let mut t = cite("#+bibliography: refs.json\nSee [cite:@lamport94b] and [cite:@stallman].\n");
    t.goto(60);
    t.ed.press("C-c C-o").unwrap();
    assert_eq!(t.ed.window_buffer().name, "refs.json");
    let at = JSON.find("\"id\": \"stallman\"").unwrap();
    assert_eq!(t.ed.window_buffer().point(), JSON[..at].rfind('{').unwrap());
}

/// Citations are fontified with org-cite, known keys with org-cite-key
/// and their entry, printed plainly, as help, unknown ones with error and
/// the keys close to them.
#[test]
fn citations_are_fontified_with_their_entries() {
    let mut t = cite("See [cite:@knuth84;@org] and [cite:@knuth48].\n");
    t.ed.redisplay();
    let face = |t: &mut Cite, pos: usize| t.eval(&format!("e8.getTextProperty({}, 'face')", HEADER.len() + pos));
    let prop = |t: &mut Cite, pos: usize, name: &str| t.eval(&format!("e8.getTextProperty({}, '{name}')", HEADER.len() + pos));
    assert_eq!(face(&mut t, 4), "\"org-cite\"");
    assert_eq!(face(&mut t, 12), "[\"org-cite-key\",\"org-cite\"]");
    assert_eq!(prop(&mut t, 12, "help-echo"), "\"Knuth. The {\\\\TeX}book, Addison-Wesley, 1984.\"");
    assert_eq!(prop(&mut t, 20, "help-echo"), "\"Org Team. The Org Manual, GNU Project, 2021.\"");
    assert_eq!(face(&mut t, 38), "[\"error\",\"org-cite\"]");
    assert_eq!(prop(&mut t, 38, "help-echo"), "\"Suggestions (mouse-1 to substitute): knuth84\"");
    assert_eq!(face(&mut t, 0), "undefined");
    let _ = &t.dir;
}
