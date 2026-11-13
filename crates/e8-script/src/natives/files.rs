//! Files.

use crate::natives::{natives, Field, Fields, Opt};
use crate::*;

natives! {
    /// The hash of a string, or of a buffer's text from `start` to `end`
    /// (the whole of it by default), as secure-hash: the text's bytes, raw
    /// bytes as themselves and the rest as UTF-8, by "md5", "sha1",
    /// "sha224", "sha256", "sha384" or "sha512", in hex, or with `binary`
    /// as a string of bytes.
    #[ts = "(algorithm: \"md5\" | \"sha1\" | \"sha224\" | \"sha256\" | \"sha384\" | \"sha512\", object: string | Buffer, start?: number | null, end?: number | null, binary?: boolean): string"]
    pub fn secureHash(ed, algorithm: String, object: EditorValue, start: Option<usize>, end: Option<usize>, binary: Option<bool>) -> String {
        let text = hashed_text(ed, &object, start, end)?;
        let hash = e8_core::hashes::digest(&algorithm, &e8_core::hashes::text_bytes(&text))?;
        Ok(if binary.unwrap_or(false) { e8_core::coding::string_of_bytes(&hash) } else { e8_core::hashes::hex(&hash) })
    }

    /// The MD5 hash of a string or a buffer's text, in hex, as md5.
    #[ts = "(object: string | Buffer, start?: number | null, end?: number | null): string"]
    pub fn md5(ed, object: EditorValue, start: Option<usize>, end: Option<usize>) -> String {
        let text = hashed_text(ed, &object, start, end)?;
        Ok(e8_core::hashes::hex(&e8_core::hashes::digest("md5", &e8_core::hashes::text_bytes(&text))?))
    }

    /// The algorithms secureHash knows, as secure-hash-algorithms.
    pub fn secureHashAlgorithms(ed) -> Vec<String> {
        let _ = ed;
        Ok(e8_core::hashes::ALGORITHMS.iter().map(|s| s.to_string()).collect())
    }

    /// Whether gzip and zlib data can be decompressed, as zlib-available-p: always.
    #[ts = "(): true"]
    pub fn zlibAvailableP(ed) -> bool {
        let _ = ed;
        Ok(true)
    }

    /// Replace gzip or zlib data in the region, its characters taken as
    /// bytes, with the data it holds, as raw bytes, as
    /// zlib-decompress-region: true when all of it was, else undefined and
    /// the region as it was, or with `allowPartial` the number of bytes not
    /// decompressed and the region what was.
    #[ts = "(start: number, end: number, allowPartial?: boolean): true | number | undefined"]
    pub fn zlibDecompressRegion(ed, start: usize, end: usize, allow_partial: Option<bool>) -> Option<EditorValue> {
        Ok(match ed.zlib_decompress_region(start, end, allow_partial.unwrap_or(false))? {
            e8_core::decompress::Decompressed::Whole => Some(EditorValue::Bool(true)),
            e8_core::decompress::Decompressed::Partly(left) => Some(EditorValue::Number(left as f64)),
            e8_core::decompress::Decompressed::Failed => None,
        })
    }

    /// The file that defined a name, as symbol-file: its function
    /// ("defun"), variable ("defvar") or face ("defface"), or without
    /// `type` whichever it has; undefined for what E8 defines itself. A
    /// package E8 ships gives its file in E8's source, as
    /// "packages/files.ts"; a file of one's own, its absolute name.
    #[ts = "(symbol: string, type?: \"defun\" | \"defvar\" | \"defface\" | (string & {})): string | undefined"]
    pub fn symbolFile(ed, symbol: String, kind: Option<String>) -> Option<String> {
        Ok(ed.symbol_file(&symbol, kind.as_deref()).map(|file| {
            if file.starts_with("packages/") { file } else { ed.expand_file_name(&file).display().to_string() }
        }))
    }

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
        ed.verify_visited_file_modtime()
    }

    /// When the current buffer's file was last modified as the buffer
    /// knows it, in milliseconds since 1970, as visited-file-modtime: 0 if
    /// it knows none, and -1 if the file did not exist when visited.
    pub fn visitedFileModtime(ed) -> f64 {
        Ok(match ed.buffer().visited_file_modtime() {
            Ok(Some(t)) => milliseconds(t),
            Ok(None) => -1.0,
            Err(()) => 0.0,
        })
    }

    /// Takes the current buffer's file's modification time now, or `time`
    /// in milliseconds since 1970, as the one it was visited at, as
    /// set-visited-file-modtime: 0 and -1, as visitedFileModtime gives
    /// them, for none known and a file that does not exist. A time that is
    /// the file's own, as visitedFileModtime or fileAttributes gave it, is
    /// taken as the file has it, to the nanosecond.
    #[ts = "(time?: number | null): void"]
    pub fn setVisitedFileModtime(ed, time: Option<f64>) {
        match time {
            None => ed.buffer_mut().take_visited_file_modtime(),
            Some(0.0) => ed.buffer_mut().clear_visited_file_modtime(),
            Some(-1.0) => ed.buffer_mut().set_visited_file_modtime_to(None),
            Some(ms) => {
                let now = ed.buffer().visited_file_modtime_now().filter(|t| milliseconds(*t) == ms);
                let time = now.unwrap_or_else(|| {
                    let nanos = (ms * 1e6).round();
                    if nanos >= 0.0 { std::time::UNIX_EPOCH + std::time::Duration::from_nanos(nanos as u64) } else { std::time::UNIX_EPOCH - std::time::Duration::from_nanos(-nanos as u64) }
                });
                ed.buffer_mut().set_visited_file_modtime_to(Some(time));
            }
        }
        Ok(())
    }

    /// Forgets when the current buffer's file was modified, as
    /// clear-visited-file-modtime, so it is taken as unchanged.
    pub fn clearVisitedFileModtime(ed) {
        ed.buffer_mut().clear_visited_file_modtime();
        Ok(())
    }

    /// Whether the current buffer was auto-saved since it was visited or
    /// last saved, as recent-auto-save-p.
    pub fn recentAutoSaveP(ed) -> bool {
        Ok(ed.buffer().recent_auto_save_p())
    }

    /// Takes the current buffer as auto-saved as it is now, as
    /// set-buffer-auto-saved.
    pub fn setBufferAutoSaved(ed) {
        ed.buffer_mut().set_buffer_auto_saved();
        Ok(())
    }

    /// Forgets that auto-saving the current buffer failed, as
    /// clear-buffer-auto-save-failure. E8 does not stop auto-saving a
    /// buffer after failures, so there is nothing to forget.
    pub fn clearBufferAutoSaveFailure(ed) {
        let _ = ed;
        Ok(())
    }

    /// Locks a file, as lock-file: makes its lock file unless
    /// create-lockfiles is off, signalling file-locked if another process
    /// holds it.
    pub fn lockFile(ed, file: String) {
        ed.lock_file(&file)
    }

    /// Takes a file's lock away if E8 holds it, as unlock-file.
    pub fn unlockFile(ed, file: String) {
        ed.unlock_file(&file);
        Ok(())
    }

    /// Locks `file`, or the current buffer's, if the buffer is modified, as
    /// lock-buffer.
    #[ts = "(file?: string | null): void"]
    pub fn lockBuffer(ed, file: Option<String>) {
        ed.lock_buffer(file.as_deref())
    }

    /// Takes the current buffer's file's lock away if the buffer is
    /// modified, as unlock-buffer.
    pub fn unlockBuffer(ed) {
        ed.unlock_buffer();
        Ok(())
    }

    /// Deletes a file, asking no file name handler, as delete-file-internal:
    /// a file that does not exist is no error.
    pub fn deleteFileInternal(ed, file: String) {
        let path = ed.expand_file_name(&file);
        ed.delete_file(&path, false)
    }

    /// Deletes an empty directory, asking no file name handler, as
    /// delete-directory-internal.
    pub fn deleteDirectoryInternal(ed, dir: String) {
        let path = ed.expand_file_name(&dir);
        ed.delete_directory_internal(&path)
    }

    /// Makes a directory, asking no file name handler, as
    /// make-directory-internal: file-already-exists if it is there.
    pub fn makeDirectoryInternal(ed, dir: String) {
        let path = ed.expand_file_name(&dir);
        ed.make_directory(&path, false)
    }

    /// Makes a file, or with `dirFlag` true a directory, or with 0 only a
    /// name not in use, starting with the absolute `prefix` and ending
    /// with `suffix`, holding `text`, as make-temp-file-internal. Gives its
    /// name.
    #[ts = "(prefix: string, dirFlag: boolean | 0 | null, suffix: string, text?: string | null): string"]
    pub fn makeTempFileInternal(ed, prefix: String, dir_flag: EditorValue, suffix: String, text: Option<String>) -> String {
        let kind = match dir_flag {
            EditorValue::Number(n) if n == 0.0 => e8_core::TempKind::NameOnly,
            v if v.is_true() => e8_core::TempKind::Directory,
            _ => e8_core::TempKind::File,
        };
        let prefix = ed.expand_file_name(&prefix).display().to_string();
        ed.make_temp_file_internal(&prefix, kind, &suffix, text.as_deref())
    }

    /// Moves a file or directory to the system's trash, as
    /// system-move-file-to-trash.
    pub fn systemMoveFileToTrash(ed, file: String) {
        let path = ed.expand_file_name(&file);
        ed.system_move_file_to_trash(&path)
    }

    /// The directory a file name stands for where a program can use it, as
    /// unhandled-file-name-directory: the name as a directory, unless a file
    /// name handler says otherwise, as one for a remote name says there is
    /// none.
    pub fn unhandledFileNameDirectory(ed, file: String) -> Option<String> {
        ed.unhandled_file_name_directory(&file)
    }

    /// The size of the file system a file is on, and the bytes free and free
    /// to E8, as file-system-info; undefined where the system does not say.
    #[ts = "(file: string): [total: number, free: number, available: number] | undefined"]
    pub fn fileSystemInfo(ed, file: String) -> Option<Vec<f64>> {
        Ok(ed.file_system_info(&file)?.map(|i| i.to_vec()))
    }

    /// Writes what the system holds of files to disk, as unix-sync.
    pub fn unixSync(ed) {
        let _ = ed;
        e8_core::vfs::sync();
        Ok(())
    }

    /// Switches a standard stream between text and binary, as
    /// set-binary-mode: something only MS-DOS and Windows tell apart, so
    /// it does nothing and gives true, as Emacs does elsewhere.
    #[ts = "(stream: \"stdin\" | \"stdout\" | \"stderr\", mode: unknown): true"]
    pub fn setBinaryMode(ed, stream: String, mode: EditorValue) -> bool {
        let _ = (ed, stream, mode);
        Ok(true)
    }

    /// A file's access control list, as file-acl: undefined, as Emacs
    /// gives where it supports none, as E8 does not.
    pub fn fileAcl(ed, file: String) -> Option<String> {
        let _ = (ed, file);
        Ok(None)
    }

    /// Sets a file's access control list, as set-file-acl: false, as E8
    /// supports none.
    pub fn setFileAcl(ed, file: String, acl: EditorValue) -> bool {
        let _ = (ed, file, acl);
        Ok(false)
    }

    /// A file's SELinux context, as file-selinux-context: [user, role,
    /// type, range], all null, as E8 supports none.
    #[ts = "(file: string): [null, null, null, null]"]
    pub fn fileSelinuxContext(ed, file: String) -> Vec<EditorValue> {
        let _ = (ed, file);
        Ok(vec![EditorValue::Null; 4])
    }

    /// Sets a file's SELinux context, as set-file-selinux-context: false,
    /// as E8 supports none.
    pub fn setFileSelinuxContext(ed, file: String, context: EditorValue) -> bool {
        let _ = (ed, file, context);
        Ok(false)
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
        let args = vec![
            EditorValue::Bool(full == Some(true)),
            pattern.clone().map_or(EditorValue::Null, EditorValue::Str),
            EditorValue::Bool(nosort == Some(true)),
            id_format,
            count.map_or(EditorValue::Null, |c| EditorValue::Number(c as f64)),
        ];
        if let Some(r) = ed.directory_files_and_attributes_handled(&dir, args) {
            return Ok(match r? {
                EditorValue::List(items) => items.into_iter().map(Field::from).collect(),
                _ => Vec::new(),
            });
        }
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
        let name = |v: &[EditorValue]| match v.first() {
            Some(EditorValue::Str(n)) => Ok(n.clone()),
            other => Err(e8_core::Error::signal("wrong-type-argument", "Wrong type argument", vec![EditorValue::Symbol("stringp".into()), other.cloned().unwrap_or(EditorValue::Null)])),
        };
        Ok(name(&a)? < name(&b)?)
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

/// A time as milliseconds since 1970, to the nanosecond as far as a number holds it.
fn milliseconds(t: std::time::SystemTime) -> f64 {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as f64 / 1e6,
        Err(e) => -(e.duration().as_nanos() as f64) / 1e6,
    }
}

/// What secure-hash and md5 hash: a string, or a buffer's text from
/// `start` to `end`, its accessible part by default, as fns.c takes them;
/// a string's from `start` to `end` characters.
fn hashed_text(ed: &mut e8_core::Editor, object: &EditorValue, start: Option<usize>, end: Option<usize>) -> Result<String, e8_core::Error> {
    let out_of_range = || e8_core::Error::signal("args-out-of-range", "Args out of range", vec![object.clone()]);
    match object {
        EditorValue::Str(s) => {
            let len = s.chars().count();
            let (a, b) = (start.unwrap_or(0), end.unwrap_or(len));
            if a > b || b > len {
                return Err(out_of_range());
            }
            Ok(s.chars().skip(a).take(b - a).collect())
        }
        EditorValue::Text(t) => {
            let s = t.string.clone();
            let len = s.chars().count();
            let (a, b) = (start.unwrap_or(0), end.unwrap_or(len));
            if a > b || b > len {
                return Err(out_of_range());
            }
            Ok(s.chars().skip(a).take(b - a).collect())
        }
        EditorValue::Buffer(id) => {
            let index = ed.buffer_with_id(*id).ok_or_else(|| e8_core::Error::new("Selecting deleted buffer"))?;
            let b = &ed.buffers()[index];
            let (a, z) = (start.unwrap_or(b.point_min()), end.unwrap_or(b.point_max()));
            let (a, z) = (a.min(z), a.max(z));
            if a < b.point_min() || z > b.point_max() {
                return Err(out_of_range());
            }
            Ok(b.slice(a..z))
        }
        _ => Err(e8_core::Error::signal("wrong-type-argument", "Wrong type argument: stringp", vec![object.clone()])),
    }
}
