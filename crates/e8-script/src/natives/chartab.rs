//! Char-tables, case tables and category tables, as chartab.c, casetab.c
//! and category.c give them to Lisp.

use e8_core::chartab::CharRange;

use crate::*;
use crate::natives::{natives, Any, Opt};

/// A char-table's id as the value scripts hold.
fn ct(id: u64) -> EditorValue {
    EditorValue::CharTable(id)
}

/// The char-table a value is.
fn table(v: EditorValue) -> Result<u64> {
    match v {
        EditorValue::CharTable(id) => Ok(id),
        _ => Err(Error::signal("wrong-type-argument", "Wrong type argument: char-table-p", Vec::new())),
    }
}

/// The char-table a value is, or none for null or when left out.
fn optional(v: Opt<EditorValue>) -> Result<Option<u64>> {
    match v.0 {
        None | Some(EditorValue::Null) => Ok(None),
        Some(EditorValue::CharTable(id)) => Ok(Some(id)),
        Some(_) => Err(type_error("Expected a char-table")),
    }
}

fn type_error(message: &str) -> Error {
    Error::signal("wrong-type-argument", message, Vec::new())
}

/// A character as scripts give one: a code point, or a string of one character.
fn char_code(value: &EditorValue) -> Option<u32> {
    match value {
        EditorValue::Number(n) => Some(*n as u32),
        EditorValue::Str(s) => s.chars().next().map(|c| c as u32),
        _ => None,
    }
}

/// A range as scripts give one: null for the default, a character, or [from, to].
fn char_range(value: &EditorValue) -> Option<CharRange> {
    match value {
        EditorValue::Null => Some(CharRange::Default),
        EditorValue::List(pair) => Some(CharRange::Range(char_code(pair.first()?)?, char_code(pair.get(1)?)?)),
        v => char_code(v).map(CharRange::Char),
    }
}

natives! {
    fn makeCharTable(ed, subtype: String, init: EditorValue) -> EditorValue {
        let id = ed.make_char_table(&subtype, init)?;
        Ok(ct(id))
    }

    /// A category table with no categories, as make-category-table.
    #[ts = "(): CharTable"]
    pub fn makeCategoryTable(ed) -> EditorValue {
        let id = ed.make_category_table();
        Ok(ct(id))
    }

    fn charTableP(ed, v: Any) -> bool {
        Ok(matches!(v.0, Some(EditorValue::CharTable(id)) if ed.char_table_p(id)))
    }

    /// What a char-table is for, as char-table-subtype: "case-table", "category-table" or what make-char-table was given.
    #[ts = "(table: CharTable): string"]
    pub fn charTableSubtype(ed, t: EditorValue) -> String {
        ed.char_table_subtype(table(t)?)
    }

    fn charTableParent(ed, t: EditorValue) -> EditorValue {
        Ok(ed.char_table_parent(table(t)?)?.map_or(EditorValue::Null, ct))
    }

    fn setCharTableParent(ed, t: EditorValue, parent: Opt<EditorValue>) {
        let parent = optional(parent)?;
        ed.set_char_table_parent(table(t)?, parent)
    }

    fn charTableExtraSlot(ed, t: EditorValue, n: usize) -> EditorValue {
        ed.char_table_extra_slot(table(t)?, n)
    }

    #[ts = "(table: CharTable, n: number, value: Value): void"]
    pub fn setCharTableExtraSlot(ed, t: EditorValue, n: usize, v: EditorValue) {
        ed.set_char_table_extra_slot(table(t)?, n, v)
    }

    fn charTableRange(ed, t: EditorValue, range: EditorValue) -> EditorValue {
        let range = char_range(&range).ok_or_else(|| type_error("A range is null, a character or [from, to]"))?;
        ed.char_table_range(table(t)?, range)
    }

    /// Set the value for a range, as set-char-table-range: the default for null, else every character in it.
    #[ts = "(table: CharTable, range: CharRange, value: Value): void"]
    pub fn setCharTableRange(ed, t: EditorValue, range: EditorValue, v: EditorValue) {
        let range = char_range(&range).ok_or_else(|| type_error("A range is null, a character or [from, to]"))?;
        ed.set_char_table_range(table(t)?, range, v)
    }

    /// Each run of characters with one value, as `[c, value]` or `[[from, to], value]`.
    fn mapCharTable(ed, t: EditorValue) -> EditorValue {
        let runs = ed.map_char_table(table(t)?)?;
        let list = runs
            .into_iter()
            .map(|(first, last, v)| {
                let key = if first == last { EditorValue::Number(first as f64) } else { EditorValue::List(vec![EditorValue::Number(first as f64), EditorValue::Number(last as f64)]) };
                EditorValue::List(vec![key, v])
            })
            .collect();
        Ok(EditorValue::List(list))
    }

    fn copyCharTable(ed, t: EditorValue) -> EditorValue {
        Ok(ct(ed.copy_char_table(table(t)?)?))
    }

    fn copyCategoryTable(ed, t: Opt<EditorValue>) -> EditorValue {
        let t = optional(t)?;
        Ok(ct(ed.copy_category_table(t)?))
    }

    fn defineCategory(ed, d: String, doc: String, t: Opt<EditorValue>) {
        let t = optional(t)?;
        ed.define_category(d.chars().next().unwrap_or(' '), &doc, t)
    }

    fn categoryDocstring(ed, d: String, t: Opt<EditorValue>) -> Option<String> {
        let t = optional(t)?;
        ed.category_docstring(d.chars().next().unwrap_or(' '), t)
    }

    fn getUnusedCategory(ed, t: Opt<EditorValue>) -> Option<String> {
        let t = optional(t)?;
        Ok(ed.get_unused_category(t)?.map(|c| c.to_string()))
    }

    /// A character's categories in the current buffer, as char-category-set and category-set-mnemonics give them: ".Lalr" for a.
    #[ts = "(c: CharCode): string"]
    pub fn charCategorySet(ed, c: EditorValue) -> String {
        let c = char_code(&c).and_then(char::from_u32).ok_or_else(|| type_error("Expected a character"))?;
        Ok(ed.char_category_set(c))
    }

    /// A category set's designators as a string, as category-set-mnemonics; E8 keeps a set as that string already.
    pub fn categorySetMnemonics(_ed, set: String) -> String {
        Ok(set)
    }

    /// The category set some designators make, as make-category-set; signals for a character that designates none.
    pub fn makeCategorySet(_ed, mnemonics: String) -> String {
        let mut out = String::new();
        for d in mnemonics.chars() {
            if !(' '..='~').contains(&d) {
                return Err(Error::signal("error", format!("Invalid category mnemonic: {d}"), Vec::new()));
            }
            if !out.contains(d) {
                out.push(d);
            }
        }
        let mut designators: Vec<char> = out.chars().collect();
        designators.sort_unstable();
        Ok(designators.into_iter().collect())
    }

    /// The char-table of a Unicode property, as unicode-property-table-internal, or undefined for one E8 holds no data for.
    #[ts = "(property: string): CharTable | undefined"]
    pub fn unicodePropertyTableInternal(ed, property: String) -> Option<EditorValue> {
        Ok(ed.unicode_property_table(&property).map(ct))
    }

    /// A character's value in a Unicode property's table, as get-unicode-property-internal.
    #[ts = "(table: CharTable, c: CharCode): Value"]
    pub fn getUnicodePropertyInternal(ed, t: EditorValue, c: EditorValue) -> EditorValue {
        let c = char_code(&c).ok_or_else(|| type_error("Expected a character"))?;
        Ok(ed.char_table_get(table(t)?, c))
    }

    /// Gives a character a value in a Unicode property's table, as put-unicode-property-internal.
    #[ts = "(table: CharTable, c: CharCode, value: Value): void"]
    pub fn putUnicodePropertyInternal(ed, t: EditorValue, c: EditorValue, v: EditorValue) {
        let c = char_code(&c).ok_or_else(|| type_error("Expected a character"))?;
        ed.char_table_set(table(t)?, c, v)
    }

    fn modifyCategoryEntry(ed, range: EditorValue, d: String, t: Opt<EditorValue>, reset: Opt<bool>) {
        let range = char_range(&range).ok_or_else(|| type_error("A range is a character or [from, to]"))?;
        let t = optional(t)?;
        ed.modify_category_entry(range, d.chars().next().unwrap_or(' '), t, reset.0.unwrap_or(false))
    }

    /// The standard case table, which buffers without their own use, as standard-case-table.
    #[ts = "(): CharTable"]
    pub fn standardCaseTable(ed) -> EditorValue {
        Ok(ct(ed.standard_case_table()))
    }

    /// The current buffer's case table, as current-case-table.
    #[ts = "(): CharTable"]
    pub fn currentCaseTable(ed) -> EditorValue {
        Ok(ct(ed.current_case_table()))
    }

    /// The standard category table, as standard-category-table.
    #[ts = "(): CharTable"]
    pub fn standardCategoryTable(ed) -> EditorValue {
        Ok(ct(ed.standard_category_table()))
    }

    /// The current buffer's category table, as category-table, which \cX in regexps follows.
    #[ts = "(): CharTable"]
    pub fn categoryTable(ed) -> EditorValue {
        Ok(ct(ed.category_table()))
    }

    /// Make a case table the current buffer's, as set-case-table: changing
    /// case and folding case in searches follow it.
    #[ts = "(table: CharTable): void"]
    pub fn setCaseTable(ed, t: EditorValue) {
        ed.set_case_table(table(t)?)
    }

    #[ts = "(table: CharTable): void"]
    pub fn setStandardCaseTable(ed, t: EditorValue) {
        ed.set_standard_case_table(table(t)?)
    }

    #[ts = "(table: CharTable): void"]
    pub fn setCategoryTable(ed, t: EditorValue) {
        ed.set_category_table(table(t)?)
    }

    fn caseTableP(ed, v: Any) -> bool {
        Ok(matches!(v.0, Some(EditorValue::CharTable(id)) if ed.case_table_p(id)))
    }

    fn categoryTableP(ed, v: Any) -> bool {
        Ok(matches!(v.0, Some(EditorValue::CharTable(id)) if ed.category_table_p(id)))
    }
}
