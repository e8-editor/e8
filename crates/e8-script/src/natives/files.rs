//! Files.

use crate::natives::{natives, Field, Fields, Opt};
use crate::*;

natives! {
    /// What a symbolic link points to, as file-symlink-p, or undefined if the file is not one.
    pub fn fileSymlinkP(ed, file: String) -> Option<String> {
        ed.file_symlink_p(&file)
    }

    /// Whether `a` was modified after `b`, or exists where `b` does not, as file-newer-than-file-p.
    pub fn fileNewerThanFileP(ed, a: String, b: String) -> bool {
        ed.file_newer_than_file_p(&a, &b)
    }

    fn fileModes(ed, file: String, nofollow: Opt<bool>) -> Option<u32> {
        ed.file_modes(&file, nofollow.0.unwrap_or(false))
    }

    /// Set a file's mode bits, as set-file-modes.
    pub fn setFileModes(ed, file: String, mode: u32) {
        ed.set_file_modes(&file, mode)
    }

    /// Set when a file was last modified and read, in milliseconds since 1970, or to now, as set-file-times.
    #[ts = "(file: string, time?: number): void"]
    pub fn setFileTimes(ed, file: String, time: Opt<Option<f64>>) {
        ed.set_file_times(&file, time.0.flatten())
    }

    /// Whether the file system holding a file ignores the case of names, as file-name-case-insensitive-p.
    pub fn fileNameCaseInsensitiveP(ed, file: String) -> bool {
        Ok(ed.file_name_case_insensitive_p(&file))
    }

    /// Make `link` a symbolic link to `target`, kept as written, as make-symbolic-link; a file already there is replaced only if `okIfExists`.
    pub fn makeSymbolicLink(ed, target: String, link: String, ok_if_exists: Opt<bool>) {
        let link = ed.expand_file_name(&link);
        ed.make_symbolic_link(&target, &link, ok_if_exists.0.unwrap_or(false))
    }

    /// Give a file another name, a hard link, as add-name-to-file; a file already there is replaced only if `okIfExists`.
    pub fn addNameToFile(ed, file: String, newname: String, ok_if_exists: Opt<bool>) {
        let (file, new) = (ed.expand_file_name(&file), ed.expand_file_name(&newname));
        ed.add_name_to_file(&file, &new, ok_if_exists.0.unwrap_or(false))
    }

    /// A file's name with the symbolic links in it followed, as file-truename.
    pub fn fileTruename(ed, file: String) -> String {
        ed.file_truename(&file)
    }

    fn makeTempFile(ed, prefix: String, dir: bool, suffix: String, text: Opt<Option<String>>) -> String {
        ed.make_temp_file(&prefix, dir, &suffix, text.0.flatten().as_deref())
    }

    fn findFileNameHandler(ed, file: String, operation: String) -> EditorValue {
        let handler = ed.find_file_name_handler(&file, &operation);
        Ok(handler.unwrap_or(EditorValue::Null))
    }

    /// A file name with $VAR and ${VAR} from the environment, and starting again after // or /~, as substitute-in-file-name.
    pub fn substituteInFileName(ed, file: String) -> String {
        e8_core::substitute_in_file_name(&file)
    }

    fn fileNameConcat(ed, parts: Vec<String>) -> String {
        Ok(e8_core::file_name_concat(&parts.iter().map(String::as_str).collect::<Vec<_>>()))
    }

    /// `[file, characters inserted]`.
    fn insertFileContents(ed, file: String, options: Fields) -> EditorValue {
        let at = |name| options.number(name).map(|n| n as usize);
        let (name, n) = ed.insert_file_contents(&file, options.flag("visit"), at("beg"), at("end"), options.flag("replace"))?;
        Ok(EditorValue::List(vec![EditorValue::Str(name), EditorValue::Number(n as f64)]))
    }

    /// `start` is null for the whole buffer, text to write, or where the region starts.
    fn writeRegion(ed, start: EditorValue, end: Option<usize>, file: String, options: Fields) {
        let source = match start {
            EditorValue::Null => e8_core::WriteSource::Buffer,
            EditorValue::Str(text) => e8_core::WriteSource::Text(text),
            start => {
                let a = start.as_number().unwrap_or(0.0) as usize;
                e8_core::WriteSource::Region(a, end.unwrap_or(a))
            }
        };
        let visit = match options.get("visit") {
            Some(EditorValue::Str(name)) => e8_core::Visit::Name(name.clone()),
            Some(EditorValue::Bool(true)) => e8_core::Visit::Yes,
            _ if options.flag("quiet") => e8_core::Visit::Quiet,
            _ => e8_core::Visit::No,
        };
        ed.write_region(source, &file, options.flag("append"), visit, options.flag("mustbenew"))
    }

    /// Whose lock a file has, as file-locked-p: true for E8's own, the other process's user@host (pid N), or undefined.
    #[ts = "(file: string): true | string | undefined"]
    pub fn fileLockedP(ed, file: String) -> Field {
        Ok(match ed.file_locked_p(&file)? {
            e8_core::filelock::LockOwner::None => Field::Undefined,
            e8_core::filelock::LockOwner::Me => Field::from(true),
            e8_core::filelock::LockOwner::Other(owner) => Field::from(owner),
        })
    }

    /// The permissions new files may have, as default-file-modes: those
    /// the umask leaves, such as 0o755.
    pub fn defaultFileModes(ed) -> u32 {
        Ok(e8_core::vfs::default_file_modes())
    }

    /// Sets the permissions new files may have, as set-default-file-modes:
    /// the umask, for E8 and the programs it starts afterwards.
    pub fn setDefaultFileModes(ed, modes: u32) {
        e8_core::vfs::set_default_file_modes(modes);
        Ok(())
    }

    fn verifyVisitedFileModtime(ed) -> bool {
        Ok(ed.buffer().verify_visited_file_modtime())
    }

    /// When the current buffer's file was last modified as the buffer
    /// knows it, in milliseconds since 1970, as visited-file-modtime: 0 if
    /// it knows none, and -1 if the file did not exist when visited.
    pub fn visitedFileModtime(ed) -> f64 {
        Ok(match ed.buffer().visited_file_modtime() {
            Ok(Some(t)) => t.duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64),
            Ok(None) => -1.0,
            Err(()) => 0.0,
        })
    }

    /// Takes the current buffer's file's modification time now, or `time`
    /// in milliseconds since 1970, as the one it was visited at, as
    /// set-visited-file-modtime.
    #[ts = "(time?: number | null): void"]
    pub fn setVisitedFileModtime(ed, time: Option<f64>) {
        match time {
            Some(ms) => ed.buffer_mut().set_visited_file_modtime_to(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0.0) as u64)),
            None => ed.buffer_mut().set_visited_file_modtime(),
        }
        Ok(())
    }

    /// Forgets when the current buffer's file was modified, as
    /// clear-visited-file-modtime, so it is taken as unchanged.
    pub fn clearVisitedFileModtime(ed) {
        ed.buffer_mut().clear_visited_file_modtime();
        Ok(())
    }

    /// Signals the error reading a file would, as access-file: file-missing
    /// or permission-denied, `string` saying what was being done.
    pub fn accessFile(ed, file: String, string: String) {
        ed.access_file(&file, &string)
    }

    /// Completes a file name in a directory, as file-name-completion: the
    /// longest start the names beginning with `file` share, a directory's
    /// with a slash; true if `file` is the one name; undefined if none
    /// begins so. Names completion-ignored-extensions lists, and . and ..,
    /// count only when nothing else does; `predicate` is called with each
    /// name, default-directory being the directory.
    #[ts = "(file: string, directory: string, predicate?: ((name: string) => unknown) | string | null): string | true | undefined"]
    pub fn fileNameCompletion(ed, file: String, dir: String, predicate: EditorValue) -> Option<EditorValue> {
        let predicate = predicate.is_true().then_some(predicate);
        Ok(match ed.file_name_completion(&file, &dir, predicate.as_ref())? {
            EditorValue::Null => None,
            v => Some(v),
        })
    }

    /// The names in a directory that start with `file`, as
    /// file-name-all-completions: . and .. among them, a directory's ending
    /// in a slash.
    pub fn fileNameAllCompletions(ed, file: String, dir: String) -> Vec<String> {
        ed.file_name_all_completions(&file, &dir)
    }

    /// A directory's names with their attributes, as
    /// directory-files-and-attributes: each `[name, attributes]`, as
    /// directoryFiles and fileAttributes give them. `idFormat` is accepted
    /// as in Emacs; the attributes give both ids and names.
    #[ts = "(dir: string, full?: boolean | null, match?: string | null, nosort?: boolean | null, idFormat?: unknown, count?: number | null): [string, FileAttributes | undefined][]"]
    pub fn directoryFilesAndAttributes(ed, dir: String, full: Option<bool>, pattern: Option<String>, nosort: Option<bool>, id_format: EditorValue, count: Option<usize>) -> Vec<Field> {
        let _ = id_format;
        let base = ed.expand_file_name(&dir).display().to_string();
        let names = ed.directory_files(&base, full == Some(true), pattern.as_deref(), nosort == Some(true), count)?;
        Ok(names
            .into_iter()
            .map(|name| {
                let path = std::path::Path::new(&base).join(&name);
                let attributes: Field = e8_core::fileops::file_attributes(&path).map(|a| crate::natives::variables::attributes_record(&a)).into();
                Field::List(vec![Field::from(name), attributes])
            })
            .collect())
    }

    /// Whether one entry of directoryFilesAndAttributes comes before
    /// another by name, as file-attributes-lessp.
    #[ts = "(a: [string, ...unknown[]], b: [string, ...unknown[]]): boolean"]
    pub fn fileAttributesLessp(ed, a: Vec<EditorValue>, b: Vec<EditorValue>) -> bool {
        let name = |v: &[EditorValue]| v.first().and_then(|n| n.as_str().map(str::to_string)).unwrap_or_default();
        Ok(name(&a) < name(&b))
    }

    /// Whether a file exists, through symbolic links, as file-exists-p. A file name handler may answer.
    pub fn fileExistsP(ed, file: String) -> bool {
        ed.file_exists_p(&file)
    }

    /// Whether E8 can read a file, as file-readable-p.
    pub fn fileReadableP(ed, file: String) -> bool {
        ed.file_readable_p(&file)
    }

    /// Whether E8 could write a file: the file if it exists, else its directory, as file-writable-p.
    pub fn fileWritableP(ed, file: String) -> bool {
        ed.file_writable_p(&file)
    }

    /// Whether a file can be run, or a directory entered, as file-executable-p.
    pub fn fileExecutableP(ed, file: String) -> bool {
        ed.file_executable_p(&file)
    }

    /// Whether a file is a regular file, through symbolic links, as file-regular-p.
    pub fn fileRegularP(ed, file: String) -> bool {
        ed.file_regular_p(&file)
    }

    /// Whether a directory can be listed and entered, as file-accessible-directory-p.
    pub fn fileAccessibleDirectoryP(ed, file: String) -> bool {
        ed.file_accessible_directory_p(&file)
    }

    /// Whether a file name is absolute, starting with / or ~, as file-name-absolute-p.
    pub fn fileNameAbsoluteP(ed, file: String) -> bool {
        Ok(e8_core::file_name_absolute_p(&file))
    }

    /// A file name with the home directory written as ~, as Emacs's abbreviate-file-name.
    pub fn abbreviateFileName(ed, file: String) -> String {
        let short = abbreviate_path(Path::new(&file));
        Ok(if file.ends_with('/') && !short.ends_with('/') { short + "/" } else { short })
    }
}
