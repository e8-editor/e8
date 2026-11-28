;;; record.el --- Record GNU Emacs's behaviour for E8's oracle tests  -*- lexical-binding: t -*-

;; Usage, from the repository root:
;;
;;   emacs -Q --batch -l tests/emacs/record.el
;;
;; Reads every tests/emacs/cases/*.json and writes the matching
;; tests/emacs/golden/*.json, or those under $E8_ORACLE_DIR if it is set,
;; as the fuzzer sets it.  Each case is an object with `name', `text',
;; `keys' (space separated, in `kbd' notation), and optionally `point'
;; (0-based, default 0), `modes' (minor or major modes to turn on before
;; the keys, such as "delete-selection-mode" or "org-mode"), `call' (a command and its
;; arguments, called before the keys, for commands that read the minibuffer,
;; which batch Emacs would read from stdin), `answers' (strings answering
;; the prompts the keys open, in order), `visit' (a file name the buffer
;; seems to visit, in the temporary directory, written there), `today' (a
;; YYYY-MM-DD day for Org's agenda to take as today), `agenda_files' (true
;; to make the visited file the agenda's), `windows' (true to record the
;; windows too), `files' (an object of file names and their text, written
;; into a fresh directory, target/oracle-files, for the case), `find' (one
;; of those files, or a new one holding `text', to visit for real instead
;; of the case's buffer), `disk' (text to give the visited file, changed
;; on disk as if by another program, when the keys reach <f33>),
;; `message' (true to record the last message), `capf' (a list of strings
;; that a function on completion-at-point-functions offers for the word at
;; point), `completions' (true to record the text of *Completions* if a
;; window shows it), `displayed' (true to record the buffer as it is
;; drawn: the text with overlays' display strings in place and invisible
;; text left out, as column view draws it), and
;; `platform' (an Emacs `system-type' such as
;; "darwin", for cases that only hold on one platform).
;; Cases with files record what the directory holds afterwards.
;;
;; Each case runs in a fresh Fundamental mode buffer, in a single window,
;; with an empty kill ring and no mark.  The buffer is fontified once its
;; modes are on, as redisplay would fontify it, and again at the end, when
;; the text left visible is recorded: folding and org's link brackets hide
;; text.  Batch Emacs has no redisplay, so nothing is fontified while the
;; keys run.  The keys are typed into Emacs's real command loop, so an
;; error shows its message and the next key still runs, as when a person
;; types them.  The first error is recorded.

(require 'json)
(require 'cl-lib)

;; Batch mode starts with these off; interactive Emacs has them on.
(transient-mark-mode 1)
(setq shift-select-mode t)
;; Emacs asks before narrowing to a region the first time, as E8 does; the oracle enables it on both.
(put 'narrow-to-region 'disabled nil)
;; A case's buffer may visit a file it never writes; leave no lock files.
(setq create-lockfiles nil)

(defconst e8-oracle--codings
  (cons (coding-system-priority-list)
        (mapcar (lambda (v) (cons v (default-value v)))
                '(buffer-file-coding-system default-terminal-coding-system
                  default-keyboard-coding-system default-process-coding-system
                  default-file-name-coding-system)))
  "The coding systems Emacs starts with: the priority list and the
defaults `prefer-coding-system' changes, put back before each case.")

(defun e8-oracle--reset-codings ()
  "Undo an earlier case's `prefer-coding-system', which otherwise reads
the next case files themselves as Latin-1."
  (apply #'set-coding-system-priority (car e8-oracle--codings))
  (dolist (v (cdr e8-oracle--codings))
    (set-default (car v) (cdr v))))

(defconst e8-oracle--files
  (let ((dir (getenv "E8_ORACLE_FILES")))
    (if (and dir (not (string-empty-p dir)))
        (file-name-as-directory (expand-file-name dir))
      (expand-file-name "../../target/oracle-files/" (file-name-directory load-file-name))))
  "Where cases with `files' or `find' keep their files: outside the
temporary directory, which Emacs makes no backups in.  The fuzzers
give each its own in E8_ORACLE_FILES, as they can run at once.")

;; Batch Emacs does not auto-save; interactive Emacs does, and E8 does.
(setq auto-save-default t)

(defun e8-oracle--write-file (name text)
  "Write TEXT to NAME in the case's directory, as UTF-8 bytes, or as
Latin-1 for text starting \"latin-1:\"."
  (let ((coding-system-for-write 'no-conversion)
        (bytes (if (string-prefix-p "latin-1:" text)
                   (encode-coding-string (substring text 8) 'latin-1)
                 (encode-coding-string text 'utf-8-unix))))
    (if (string-suffix-p "/" name)
        (make-directory (expand-file-name name e8-oracle--files) t)
      (make-directory (file-name-directory (expand-file-name name e8-oracle--files)) t)
      (with-temp-buffer
        (set-buffer-multibyte nil)
        (insert bytes)
        (write-region nil nil (expand-file-name name e8-oracle--files) nil 'quiet)))))

(defun e8-oracle--listing (&optional dir)
  "The case's directory: each file's name and text, as UTF-8 or else
as Latin-1 marked \"latin-1:\", and each directory as its name with a
slash, then what it holds."
  (let ((dir (or dir e8-oracle--files)))
    (mapcan (lambda (name)
              (let* ((path (expand-file-name name dir))
                     (relative (file-relative-name path e8-oracle--files)))
                (cond
                 ;; A lock file names the process that made it, so only that it is there compares.
                 ((string-prefix-p ".#" name) (list (cons relative "lock")))
                 ((file-directory-p path)
                    (cons (cons (concat relative "/") "")
                          (e8-oracle--listing (file-name-as-directory path))))
                 (t
                  (let* ((raw (with-temp-buffer
                                (set-buffer-multibyte nil)
                                (insert-file-contents-literally path)
                                (buffer-string)))
                         (text (decode-coding-string raw 'utf-8-unix)))
                    ;; Bytes that are not UTF-8 decode as raw-byte characters.
                    (list (cons relative
                                (if (seq-some (lambda (c) (>= c #x3FFF80)) text)
                                    (concat "latin-1:" (decode-coding-string raw 'latin-1))
                                  text))))))))
            (directory-files dir nil "\\`\\(?:[^.]\\|\\.#\\)"))))

(defvar e8-oracle--disk nil
  "The text <f33> gives the visited file.")

(defun e8-oracle--change-disk ()
  "Change the visited file on disk, as another program would, a little later."
  (interactive)
  (let ((file buffer-file-name))
    (e8-oracle--write-file (file-name-nondirectory file) e8-oracle--disk)
    (set-file-times file (time-add nil 5))))

(global-set-key (kbd "<f33>") #'e8-oracle--change-disk)

(defvar e8-oracle--messages-start nil
  "Where *Messages* ended when the keys began.")

(defun e8-oracle--without-dir (text)
  "TEXT with the case's directory written as DIR."
  (and text
       (let ((dir (directory-file-name e8-oracle--files)))
         (dolist (form (list (file-truename dir) dir (abbreviate-file-name dir)
                             (abbreviate-file-name (file-truename dir)))
                   text)
           (setq text (string-replace form "DIR" text))))))

(defun e8-oracle--last-message ()
  "The last message logged since the keys began, with the case's
directory written as DIR."
  (with-current-buffer (messages-buffer)
    (let ((lines (split-string (buffer-substring e8-oracle--messages-start (point-max)) "\n" t)))
      (e8-oracle--without-dir (car (last lines))))))

(defvar e8-oracle--error nil
  "The first error a case signalled.")

(defun e8-oracle--set-aside-typed-keys (run &rest args)
  "Call RUN with ARGS while the keys still waiting to be typed are set aside.
Emacs reads waiting keys before a keyboard macro's own keys, so a macro run
while the case's keys are queued would read those instead."
  (let ((queued unread-command-events))
    (setq unread-command-events nil)
    (unwind-protect
        (apply run args)
      (setq unread-command-events (append unread-command-events queued)))))

(advice-add 'call-last-kbd-macro :around #'e8-oracle--set-aside-typed-keys)
(advice-add 'execute-kbd-macro :around #'e8-oracle--set-aside-typed-keys)

(defun e8-oracle--new-reference (references)
  "The smallest number REFERENCES does not use, in place of Org's random
one, so the references an export makes, as HTML's ids, are the same in
every run; E8 counts the same way when `e8--export-sequential-references'
is set, as its oracle sets it."
  (let ((new 1))
    (while (rassq new references) (setq new (1+ new)))
    new))
(advice-add 'org-export-new-reference :override #'e8-oracle--new-reference)

(defvar e8-oracle--today nil
  "The day a case fixes, as calendar-absolute-from-gregorian counts it.")

(defvar e8-oracle--time '(12 0)
  "The hour and minute a case fixes on its day, noon unless `today' gives
one, as \"2026-11-04 09:07\".")

(defun e8-oracle--today ()
  "The case's fixed day, for org-today."
  e8-oracle--today)

(defun e8-oracle--now (&rest _)
  "The case's fixed time, noon on its day unless it gives a time, as E8's tests stamp times."
  (let ((d (calendar-gregorian-from-absolute e8-oracle--today)))
    (encode-time (list 0 (nth 1 e8-oracle--time) (nth 0 e8-oracle--time) (nth 1 d) (nth 0 d) (nth 2 d) nil -1 nil))))

(defun e8-oracle--icalendar-dtstamp (orig)
  "An iCalendar export's DTSTAMP at the case's fixed day and time, written
as UTC whatever the zone, in place of the time now, so a calendar is the
same in every run and on every machine; E8 stamps the same when
`e8--today' is set, as its oracle sets it."
  (if (not e8-oracle--today) (funcall orig)
    (let ((d (calendar-gregorian-from-absolute e8-oracle--today)))
      (format "DTSTAMP:%04d%02d%02dT%02d%02d00Z" (nth 2 d) (nth 0 d) (nth 1 d)
              (nth 0 e8-oracle--time) (nth 1 e8-oracle--time)))))
(advice-add 'org-icalendar-dtstamp :around #'e8-oracle--icalendar-dtstamp)

(defun e8-oracle--current-time (orig &rest args)
  "org-current-time as Org works it out, rounding and all, from the case's fixed time."
  (cl-letf (((symbol-function 'current-time) #'e8-oracle--now))
    (apply orig args)))

(defun e8-oracle--timestamp-to-now (timestamp-string &optional seconds)
  "org-timestamp-to-now from noon on the case's fixed day, as E8's tests count."
  (let ((fdiff (if seconds #'float-time #'time-to-days)))
    (- (funcall fdiff (org-time-string-to-time timestamp-string))
       (funcall fdiff (e8-oracle--now)))))

(defun e8-oracle--range-now (args)
  "Org's special ranges counted from noon on the case's fixed day, as E8's tests count them."
  (if (nth 1 args) args (append (list (car args) (e8-oracle--now)) (nthcdr 2 args))))

(defun e8-oracle--caption-now (write ipos tables params)
  "A clock table's caption stamped with noon on the case's fixed day, not the clock's time."
  (unwind-protect (funcall write ipos tables params)
    (save-excursion
      (goto-char ipos)
      (when (looking-at "#\\+CAPTION: [^[\n]*\\(\\[[^]\n]*\\]\\)")
        (replace-match (format-time-string "[%Y-%m-%d %a %H:%M]" (e8-oracle--now)) t t nil 1)))))

(defun e8-oracle--archive-now (archive &rest args)
  "Org's archiving commands' times stamped at noon on the case's fixed day, as they read the clock themselves: ARCHIVE_TIME and the date tree's day."
  (let ((format-time (symbol-function 'format-time-string)))
    (cl-letf (((symbol-function 'format-time-string)
               (lambda (format &optional time zone) (funcall format-time format (or time (e8-oracle--now)) zone))))
      (apply archive args))))

(defvar org-clock-start-time)
(defvar org-clock-total-time)
(defvar org-clock-marker)
(defvar org-clock-history)
(defvar org-stored-links)
(defvar org-link--insert-history)
(defvar org-clock-default-task)
(defvar org-clock-interrupted-task)
(defvar org-clock-mode-line-timer)
(defvar org-markers-to-move)
(defvar org-log-post-message)
(defvar org-time-was-given)
(defvar org-end-time-was-given)
(defvar org-agenda-restriction-lock-overlay)
(defvar org-agenda-overriding-restriction)
(defvar org-agenda-restrict)
(defvar org-agenda-restrict-begin)
(defvar org-agenda-restrict-end)
(defvar dired-mode-map)

(defun e8-oracle--clocked-time ()
  "The running clock's minutes counted to noon on the case's fixed day, as E8's tests count them."
  (+ (floor (float-time (time-subtract (e8-oracle--now) org-clock-start-time)) 60)
     (or org-clock-total-time 0)))

(defun e8-oracle--notification (notification)
  "An Org notification in the echo area, as E8 shows one with no handler, not through D-Bus, which batch Emacs has none of."
  (message "%s" notification))

(advice-add 'org-show-notification :override #'e8-oracle--notification)

(require 'calendar)
(defvar org-agenda-files)
(defvar org-capture-templates)

(defun e8-oracle--done ()
  "End the case: leave the command loop."
  (interactive)
  (exit-recursive-edit))

(global-set-key (kbd "<f35>") #'e8-oracle--done)

;; Batch Emacs reads the minibuffer from standard input, so a command that
;; prompts would wait forever.  A case's `answers' answer its prompts in
;; order, as if typed and confirmed with RET; with none left, prompting is
;; an error instead, and the fuzzer leaves out cases that hit it.
(defvar e8-oracle--answers nil
  "The answers left for the case's prompts.")

(defun e8-oracle--answer (default)
  "The next answer, or DEFAULT for an empty one, as RET on empty input gives."
  (unless e8-oracle--answers
    (error "Minibuffer read in batch"))
  (let ((answer (pop e8-oracle--answers)))
    (if (and (equal answer "") default)
        (if (consp default) (car default) default)
      answer)))

(defun e8-oracle--read-from-minibuffer (_prompt &optional _initial _keymap read _hist default &rest _)
  "Answer from the case, read as Lisp when READ asks, as typing it would be."
  (let ((answer (e8-oracle--answer default)))
    (if read (car (read-from-string answer)) answer)))
(defun e8-oracle--read-string (_prompt &optional _initial _hist default &rest _)
  (e8-oracle--answer default))
(defun e8-oracle--completing-read (_prompt _collection &optional _pred _match _initial _hist default &rest _)
  (e8-oracle--answer default))
(defun e8-oracle--yes-or-no (&rest _)
  "Answer yes-or-no-p from the case, asking again for anything but yes
or no, as Emacs does."
  (let ((answer (e8-oracle--answer nil)))
    (while (not (member answer '("yes" "no")))
      (message "Please answer yes or no.")
      (setq answer (e8-oracle--answer nil)))
    (equal answer "yes")))
(defun e8-oracle--y-or-n (&rest _)
  "Answer y-or-n-p from the case, taking an answer's first character as
the key, and asking again for anything but y or n, as Emacs does."
  (let ((answer (e8-oracle--answer nil)))
    (while (not (member (substring answer 0 (min 1 (length answer))) '("y" "n")))
      (setq answer (e8-oracle--answer nil)))
    (string-prefix-p "y" answer)))
;; call-interactively reads an interactive spec's s in C, past the advice
;; on read-string, so a command whose spec has only s, p and P codes has
;; its arguments read here instead, as Lisp, for the case's answers.
(defun e8-oracle--call-interactively (call function &optional record-flag keys)
  "Call FUNCTION as CALL does, reading the strings its spec asks for with read-string."
  (let* ((spec (and (symbolp function) (commandp function)
                    (cadr (interactive-form function))))
         (items (and (stringp spec) (split-string spec "\n"))))
    (if (and items
             (cl-some (lambda (item) (string-prefix-p "s" item)) items)
             (cl-every (lambda (item) (and (> (length item) 0) (memq (aref item 0) '(?s ?p ?P)))) items))
        (apply function
               (mapcar (lambda (item)
                         (pcase (aref item 0)
                           (?s (read-string (substring item 1)))
                           (?P current-prefix-arg)
                           (?p (prefix-numeric-value current-prefix-arg))))
                       items))
      (funcall call function record-flag keys))))
(advice-add 'call-interactively :around #'e8-oracle--call-interactively)

(defun e8-oracle--no-minibuffer (&rest _)
  (error "Minibuffer read in batch"))
;; Dired lists directories as E8 does, with Emacs's own ls, sorting
;; names by their characters.
;; *Messages* keeps everything, or the place a case's messages start
;; would move as old ones are dropped.
(setq message-log-max t)

(require 'ls-lisp)
(setq ls-lisp-use-insert-directory-program nil
      ls-lisp-use-string-collate nil
      delete-by-moving-to-trash nil)

(advice-add 'read-from-minibuffer :override #'e8-oracle--read-from-minibuffer)
(advice-add 'read-string :override #'e8-oracle--read-string)
(advice-add 'completing-read :override #'e8-oracle--completing-read)
(advice-add 'y-or-n-p :override #'e8-oracle--y-or-n)
(advice-add 'yes-or-no-p :override #'e8-oracle--yes-or-no)
(defun e8-oracle--read-char (&rest _)
  "The next answer's first character, as reading a key gives it."
  (string-to-char (e8-oracle--answer nil)))
(dolist (fn '(read-char read-char-exclusive read-key))
  (advice-add fn :override #'e8-oracle--read-char))
(defun e8-oracle--read-event (read &rest args)
  "Read an event from the case's keys while they last, as query-replace's
answers come, and then from its answers, as save-some-buffers' do."
  (if (or unread-command-events
          (and executing-kbd-macro
               (< executing-kbd-macro-index (length executing-kbd-macro))))
      (apply read args)
    (e8-oracle--read-char)))
(advice-add 'read-event :around #'e8-oracle--read-event)

;; The case's keys wait in unread-command-events, where a person types
;; them one at a time; completion-in-region--postch does nothing while keys
;; wait, so it would never hide *Completions* when point leaves the field.
(defun e8-oracle--postch-as-typed (postch)
  "Run POSTCH as after a key typed on its own."
  (let ((unread-command-events nil)) (funcall postch)))
(advice-add 'completion-in-region--postch :around #'e8-oracle--postch-as-typed)

;; Batch Emacs gives up on a file changed on disk; ask as interactive Emacs
;; does, taking the answer from the case.
(defun e8-oracle--supersession (filename)
  "Answer `ask-user-about-supersession-threat' for FILENAME from the case."
  (pcase (e8-oracle--read-char)
    (?r (revert-buffer nil (not (buffer-modified-p)))
        (signal 'file-supersession (list "File reverted" filename)))
    (?y (message "File on disk now will become a backup file if you save these changes.")
        (setq buffer-backed-up nil))
    (_ (signal 'file-supersession (list "File changed on disk" filename)))))
(advice-add 'ask-user-about-supersession-threat :override #'e8-oracle--supersession)

;; Cases must not reach outside Emacs: opening a link would start the
;; system's browser, or another program, for every case that does it.
(defun e8-oracle--no-external (&rest _)
  (error "Opening outside Emacs in batch"))
(dolist (fn '(browse-url browse-url-default-browser browse-url-default-macosx-browser
              browse-url-xdg-open org-open-file org-link-open-as-file))
  (advice-add fn :override #'e8-oracle--no-external))

;; The oracle enables these on both sides, as Emacs and E8 disable them,
;; so cases compare what the commands do rather than the question first.
(dolist (command '(upcase-region downcase-region))
  (put command 'disabled nil))

(setq command-error-function
      (lambda (data _context _caller)
        (unless e8-oracle--error
          (setq e8-oracle--error
                (if (eq (car data) 'quit) "Quit" (error-message-string data))))))

(defun e8-oracle--value (v)
  "A case's JSON value V as Lisp: true and false t and nil, a string starting with ' a symbol, with '' a quoted one, a list of such values, an object an alist of strings."
  (pcase v
    (:json-false nil)
    ('t t)
    ;; A string starting with '' is a quoted symbol, as ''day for 'day in a
    ;; custom agenda command's settings; with ' a symbol, as 'headline-data.
    ((and (pred stringp) v (guard (string-prefix-p "''" v))) (list 'quote (intern (substring v 2))))
    ((and (pred stringp) v (guard (string-prefix-p "'" v))) (intern (substring v 1)))
    ;; An object is an alist of strings, as (("NAME" . "value")).
    ((and `((,(and (pred symbolp) k) . ,_) . ,_) v (guard (not (memq k '(t :json-false)))))
     (mapcar (lambda (c) (cons (symbol-name (car c)) (cdr c))) v))
    ;; A list, each item read as a value: strings, those starting with ' symbols,
    ;; as ("'time" "'todo"), numbers, true and false as t and nil, as a plist
    ;; (":link" false), and lists, as org-agenda-custom-commands'
    ;; (("n" "Agenda" ((agenda "") (alltodo "")))), where an object of one
    ;; string is a cons, as a prefix key's ("p" . "Projects").
    ((pred consp)
     (mapcar (lambda (x)
               (pcase x
                 (`((,(and k (pred symbolp)) . ,(and d (pred stringp)))) (cons (symbol-name k) d))
                 (_ (e8-oracle--value x))))
             v))
    (v v)))

(defun e8-oracle--run (case)
  "Type CASE's keys and return the buffer's state afterwards, as an alist,
its `globals' bound for the case, before the modes start."
  (let ((globals (alist-get 'globals case)))
    (prog1 (cl-progv (mapcar #'car globals) (mapcar (lambda (g) (e8-oracle--value (cdr g))) globals)
             (e8-oracle--run-1 case))
      ;; A case that brought Org's parser up to date with its globals or
      ;; its buffer's own values, as org-list-allow-alphabetical, from
      ;; `call' or `modes', leaves it as the defaults have it.
      (when (or (equal (car (alist-get 'call case)) "org-element-update-syntax")
                (member "org-element-update-syntax" (alist-get 'modes case)))
        (with-temp-buffer (org-element-update-syntax))))))

(defun e8-oracle--run-1 (case)
  "Type CASE's keys and return the buffer's state afterwards, as an alist."
  (let ((text (alist-get 'text case))
        (keys (alist-get 'keys case))
        (start (or (alist-get 'point case) 0))
        (modes (mapcar #'intern (alist-get 'modes case)))
        (call (alist-get 'call case)))
    (e8-oracle--reset-codings)
    ;; dired-x as a case that turns on dired-omit-mode loads it: once
    ;; loaded, deleting a visited file asks whether to kill its buffer.
    (when (featurep 'dired-x)
      (unload-feature 'dired-x t)
      ;; Unloading leaves the keys it bound in dired's map, naming
      ;; functions it took away; a fresh dired has none of them.
      (dolist (key '("*(" "*O" "*." "\C-x\M-o" "\M-(" "\M-!" "F" "V"))
        (define-key dired-mode-map key nil)))
    (delete-other-windows)
    (set-window-dedicated-p nil nil)
    ;; The frame laid out afresh: an earlier case's incremental search can
    ;; grow the echo area and leave the windows a line short after it.
    ;; Batch Emacs applies a frame's new size only while it waits: without
    ;; the waits the 24 lines could land in the middle of the case, unless
    ;; an earlier case had waited, as a minibuffer message does.
    (set-frame-size (selected-frame) 80 24)
    (sleep-for 0.001)
    (set-frame-size (selected-frame) 80 25)
    (sleep-for 0.001)
    ;; A clock an earlier case left running is forgotten, not asked about
    ;; as its buffer goes, and the clock's history starts afresh, as each
    ;; E8 case starts with none.
    (when (featurep 'org-clock)
      (when (marker-buffer org-clock-marker)
        (with-current-buffer (marker-buffer org-clock-marker)
          (remove-hook 'kill-buffer-hook #'org-check-running-clock t)))
      (when (timerp org-clock-mode-line-timer) (cancel-timer org-clock-mode-line-timer))
      (setq org-clock-history nil)
      ;; Nor a resolved clock's leftover time, nor when one last stopped.
      (setq org-clock-leftover-time nil org-clock-out-time nil)
      (setq org-markers-to-move nil)
      (set-marker org-clock-default-task nil)
      (set-marker org-clock-interrupted-task nil))
    ;; Nor the bibliographies oc-basic read for an earlier case: their
    ;; strings keep the parse tree an export put them in, and a later
    ;; export inserting next to one fails ("No location found to insert
    ;; node"), as the files of different cases share their names.
    (when (featurep 'oc-basic)
      (setq org-cite-basic--bibliography-cache nil
            org-cite-basic--file-id-cache nil)
      (clrhash org-cite-basic--completion-cache))
    ;; Nor a date an agenda's capture left as the default, as
    ;; org-capture-use-agenda-date sets it for good.
    ;; Nor the message a repeating entry left for the next stored note to
    ;; show, as org-auto-repeat-maybe sets it and Org never clears it:
    ;; after a bulk action that repeats an entry without a note, a later
    ;; case's note said "Entry repeats: ..." in place of "Note stored".
    ;; Nor whether the last date read had a time, which Org binds only
    ;; around the reads that want it, and tests with boundp: unbound, as
    ;; in a fresh Emacs, not nil, or the agenda's bulk scheduling keeps
    ;; the time it is given.
    (when (featurep 'org)
      (setq org-overriding-default-time nil
            org-log-post-message nil)
      (makunbound 'org-time-was-given)
      (makunbound 'org-end-time-was-given))
    ;; Nor an agenda restriction lock (C-c C-x <), which would keep every
    ;; later agenda to the file or subtree it was set on; removed as
    ;; org-agenda-remove-restriction-lock does, with no message.
    (when (featurep 'org-agenda)
      (delete-overlay org-agenda-restriction-lock-overlay)
      (setq org-agenda-overriding-restriction nil
            org-agenda-restrict nil)
      (put 'org-agenda-files 'org-restrict nil)
      (move-marker org-agenda-restrict-begin nil)
      (move-marker org-agenda-restrict-end nil))
    ;; Org's stored links start afresh too.
    (when (featurep 'ol)
      (setq org-stored-links nil org-link--insert-history nil))
    ;; A fresh set of buffers, as E8 starts each case with: only the
    ;; ones Emacs needs, whose names start with a space, and its own.
    (dolist (b (buffer-list))
      (unless (or (string-prefix-p " " (buffer-name b))
                  (member (buffer-name b) '("*scratch*" "*Messages*")))
        (kill-buffer b)))
    ;; In the same order whatever earlier cases did, as E8 lists them:
    ;; the case's buffer, then *Messages*, then *scratch*.
    (bury-buffer "*Messages*")
    (bury-buffer "*scratch*")
    ;; Both empty, as E8 starts them: an earlier case could type into
    ;; *scratch*, and the log would hold every earlier case's messages.
    (with-current-buffer "*scratch*"
      (let ((inhibit-read-only t)) (erase-buffer))
      (setq buffer-read-only nil
            buffer-undo-list nil)
      (set-buffer-modified-p nil))
    (with-current-buffer (messages-buffer)
      (let ((inhibit-read-only t)) (erase-buffer)))
    ;; Lock files only where a case asks for them.
    (setq create-lockfiles (eq (alist-get 'lockfiles case) t))
    ;; A fresh spelling session, as E8 starts each case with: an earlier
    ;; case's would still know the words it accepted.
    (when (featurep 'ispell)
      (ispell-kill-ispell t t)
      (set-marker ispell-region-end nil)
      (setq ispell-pdict-modified-p nil
            ispell-buffer-local-name nil)
      (setq-default ispell-dictionary nil
                    ispell-local-dictionary nil))
    (with-current-buffer (e8-oracle--case-buffer case text)
      ;; The window as new, as E8's is, with no buffers shown before.
      (set-window-prev-buffers nil nil)
      (set-window-next-buffers nil nil)
      ;; As if visiting a file, for commands such as org-refile that need
      ;; one; nothing is written to it.
      (when-let* ((visit (and (not (alist-get 'find case)) (alist-get 'visit case))))
        (let ((file (expand-file-name visit temporary-file-directory)))
          ;; On disk too, as the agenda checks its files are there.
          (write-region text nil file nil 'quiet)
          (setq buffer-file-name file
                buffer-file-truename (abbreviate-file-name (file-truename file)))))
      (setq org-agenda-files (and (alist-get 'agenda_files case) (list buffer-file-name)))
      ;; Capture templates as JSON lists, the file "FILE" standing for the
      ;; visited one.
      (setq org-capture-templates
            (mapcar (lambda (tpl)
                      (list (nth 0 tpl) (nth 1 tpl) (intern (nth 2 tpl))
                            (cons (intern (car (nth 3 tpl)))
                                  ;; 'name for a function's symbol, as file+function's.
                                  (mapcar (lambda (x)
                                            (cond ((equal x "FILE") buffer-file-name)
                                                  ((and (stringp x) (string-prefix-p "'" x)) (intern (substring x 1)))
                                                  (t x)))
                                          (cdr (nth 3 tpl))))
                            (nth 4 tpl)))
                    (alist-get 'capture_templates case)))
      ;; Options after the template, as ":prepend", true: keywords and t.
      (setq org-capture-templates
            (cl-mapcar (lambda (tpl json)
                         (append tpl
                                 (mapcar (lambda (x)
                                           (pcase x
                                             ((pred (lambda (v) (and (stringp v) (string-prefix-p ":" v)))) (intern x))
                                             ;; A symbol as 'week, as vars have them.
                                             ((pred (lambda (v) (and (stringp v) (string-prefix-p "'" v)))) (intern (substring x 1)))
                                             ('t t)
                                             (:json-false nil)
                                             (_ x)))
                                         (nthcdr 5 json))))
                       org-capture-templates (alist-get 'capture_templates case)))
      ;; A fixed day for the agenda, as YYYY-MM-DD.
      (advice-remove 'org-today #'e8-oracle--today)
      (advice-remove 'org-current-time #'e8-oracle--current-time)
      (advice-remove 'org-clock-special-range #'e8-oracle--range-now)
      (advice-remove 'org-clocktable-write-default #'e8-oracle--caption-now)
      (advice-remove 'org-clock-get-clocked-time #'e8-oracle--clocked-time)
      (advice-remove 'org-archive-to-archive-sibling #'e8-oracle--archive-now)
      (advice-remove 'org-archive-subtree #'e8-oracle--archive-now)
      (advice-remove 'org-timestamp-to-now #'e8-oracle--timestamp-to-now)
      (when-let* ((day (alist-get 'today case)))
        (setq e8-oracle--today
              (calendar-absolute-from-gregorian
               (let ((d (mapcar #'string-to-number (split-string (car (split-string day " ")) "-"))))
                 (list (nth 1 d) (nth 2 d) (nth 0 d))))
              e8-oracle--time
              (if (string-match " \\([0-9]+\\):\\([0-9]+\\)\\'" day)
                  (list (string-to-number (match-string 1 day)) (string-to-number (match-string 2 day)))
                '(12 0)))
        (advice-add 'org-today :override #'e8-oracle--today)
        ;; Org's own org-current-time, from the fixed time, and so its
        ;; org-current-effective-time, which takes it.
        (advice-add 'org-current-time :around #'e8-oracle--current-time)
        ;; With timestamp_now, org-timestamp-to-now counts from it too, as the agenda's ignore options do.
        (when (eq (alist-get 'timestamp_now case) t)
          (advice-add 'org-timestamp-to-now :override #'e8-oracle--timestamp-to-now))
        (require 'org-clock)
        (advice-add 'org-clock-special-range :filter-args #'e8-oracle--range-now)
        (advice-add 'org-clocktable-write-default :around #'e8-oracle--caption-now)
        (advice-add 'org-clock-get-clocked-time :override #'e8-oracle--clocked-time)
        (require 'org-archive)
        (advice-add 'org-archive-to-archive-sibling :around #'e8-oracle--archive-now)
        (advice-add 'org-archive-subtree :around #'e8-oracle--archive-now))
      (unless (alist-get 'find case)
        (buffer-enable-undo)
        (set-buffer-modified-p nil))
      (goto-char (1+ start))
      (dolist (mode modes)
        ;; Major modes take no argument.
        (condition-case nil (funcall mode 1)
          (wrong-number-of-arguments (funcall mode))))
      ;; Variables for the case, buffer-local: true and false are t and nil.
      (dolist (var (alist-get 'vars case))
        (set (make-local-variable (car var)) (e8-oracle--value (cdr var))))
      ;; A completion function offering the case's strings for the word at point.
      (when-let* ((strings (alist-get 'capf case)))
        (add-hook 'completion-at-point-functions
                  (lambda ()
                    (let ((start (save-excursion (skip-chars-backward "-_[:alnum:]") (point)))
                          (end (save-excursion (skip-chars-forward "-_[:alnum:]") (point))))
                      (list start end strings)))
                  nil t))
      (e8-oracle--fontify)
      (setq mark-active nil
            mark-ring nil
            kill-ring nil
            kill-ring-yank-pointer nil
            last-command nil
            this-command nil
            real-this-command nil
            last-repeatable-command nil
            last-kbd-macro nil
            ;; Org keeps some state between commands in global variables.
            org-table-clip nil
            org-subtree-clip nil
            org-subtree-clip-folded nil
            e8-oracle--error nil
            e8-oracle--answers (alist-get 'answers case)
            e8-oracle--disk (alist-get 'disk case)
            ;; A line of its own first, so a message repeated from the case
            ;; before is not folded into that case's as "[2 times]".
            e8-oracle--messages-start (with-current-buffer (messages-buffer)
                                           (let ((inhibit-read-only t))
                                             (goto-char (point-max))
                                             (insert (format "-- %s\n" (alist-get 'name case)))
                                             (point-max)))
            unread-command-events (append (and call '(f34))
                                          (listify-key-sequence (kbd keys))
                                          '(f35)))
      (global-set-key (kbd "<f34>")
                      (lambda () (interactive) (apply (intern (car call)) (cdr call))))
      (recursive-edit)
      (prog1 (e8-oracle--state case text start keys)
        ;; Some modes are global; turn them off again for the next case.
        (dolist (mode modes) (ignore-errors (funcall mode -1)))))))

(defun e8-oracle--case-buffer (case text)
  "Make the buffer CASE runs in current and shown, and return it.
That is a file visited for real if CASE has `find', in a fresh directory
holding its `files', and otherwise a fresh *e8-oracle* buffer holding TEXT."
  ;; Toggles that set global variables, as isearch's M-s SPC sets
  ;; isearch-lax-whitespace, start each case as Emacs starts, as E8's
  ;; fresh editor for each case does.
  (setq isearch-lax-whitespace t
        isearch-regexp-lax-whitespace nil)
  (let ((files (alist-get 'files case))
        (find (alist-get 'find case)))
    (when (or files find)
      (when (file-directory-p e8-oracle--files)
        (delete-directory e8-oracle--files t))
      (make-directory e8-oracle--files t)
      ;; Auto-save files last, so they are newer than what they save.
      (dolist (file (sort (copy-sequence files)
                          (lambda (a b)
                            (let ((a (symbol-name (car a))) (b (symbol-name (car b))))
                              (if (eq (string-prefix-p "#" a) (string-prefix-p "#" b))
                                  (string< a b)
                                (string-prefix-p "#" b))))))
        (e8-oracle--write-file (symbol-name (car file)) (cdr file)))
      (when (and find (not (assq (intern find) files)))
        (e8-oracle--write-file find text)))
    (if find
        (let ((inhibit-message t))
          (find-file (expand-file-name find e8-oracle--files))
          ;; after-find-file leaves auto-saving off in batch Emacs.
          (auto-save-mode 1)
          (current-buffer))
      (with-current-buffer (get-buffer-create "*e8-oracle*")
        (fundamental-mode)
        (switch-to-buffer (current-buffer))
        (buffer-disable-undo)
        (insert text)
        (current-buffer)))))

(defun e8-oracle--fontify ()
  "Fontify the whole buffer, as redisplay would fontify what it shows.
Redisplay carries on when fontifying fails, so this does too: Org's
done-headline keyword can fail to match its second group."
  (let ((font-lock-fontified nil)
        (inhibit-message t))
    (ignore-errors (font-lock-ensure))))

(defun e8-oracle--visible ()
  "The buffer's text without the characters that are invisible."
  (let ((out nil))
    (dotimes (i (buffer-size))
      (unless (invisible-p (1+ i))
        (push (char-after (1+ i)) out)))
    (concat (nreverse out))))

(defun e8-oracle--dired-normalize ()
  "The Dired buffer as each line's mark and file name, leaving out the
sizes and dates that differ between runs: the text, and a function from
buffer positions to positions in it."
  (let ((out "") (lines nil))
    (save-excursion
      (goto-char (point-min))
      (while (not (eobp))
        (let* ((bol (point))
               (eol (line-end-position))
               (name (save-excursion (dired-move-to-filename)))
               (start (length out))
               (line (if name
                         ;; A link's target, absolute, is in the case's directory too.
                         (e8-oracle--without-dir
                          (concat (buffer-substring-no-properties bol (min (+ bol 2) eol))
                                  (buffer-substring-no-properties name eol)))
                       (e8-oracle--without-dir (buffer-substring-no-properties bol eol)))))
          (setq out (concat out line "\n"))
          (push (list bol eol name start (length line)) lines))
        (forward-line 1)))
    (cons out
          (lambda (pos)
            (or (seq-some
                 (pcase-lambda (`(,bol ,eol ,name ,start ,len))
                   (and (<= bol pos) (<= pos eol)
                        (+ start (cond ((null name) (min (- pos bol) len))
                                       ((>= pos name) (+ (min 2 (- name bol)) (- pos name)))
                                       (t (min (- pos bol) 2))))))
                 lines)
                (length out))))))

(defun e8-oracle--json (v)
  "A value V as `json-read' gave it, to write as it was read: its lists
as arrays, an empty one among them too, and its objects as objects."
  (cond
   ((and (consp v) (consp (car v)) (symbolp (caar v)) (not (memq (caar v) '(t :json-false))))
    (mapcar (lambda (c) (cons (car c) (e8-oracle--json (cdr c)))) v))
   ((consp v) (vconcat (mapcar (lambda (x) (if (null x) [] (e8-oracle--json x))) v)))
   (t v)))

(defun e8-oracle--state (case text start keys)
  "The current buffer's state after CASE, as an alist.
The whole buffer, even if the case left it narrowed."
  (save-restriction
    (widen)
    (e8-oracle--whole-state case text start keys)))

(defun e8-oracle--whole-state (case text start keys)
  "The current buffer's state after CASE, widened, as an alist."
      `((name . ,(alist-get 'name case))
        (input . ((text . ,text) (point . ,start) (keys . ,keys)
                  (modes . ,(vconcat (alist-get 'modes case)))
                  (call . ,(vconcat (alist-get 'call case)))
                  (platform . ,(alist-get 'platform case))
                  ,@(and (alist-get 'windows case) '((windows . t)))
                  ,@(and (alist-get 'visit case) `((visit . ,(alist-get 'visit case))))
                  ,@(and (alist-get 'today case) `((today . ,(alist-get 'today case))))
                  ,@(and (alist-get 'agenda_files case) '((agenda_files . t)))
                  ,@(and (alist-get 'capture_templates case)
                         `((capture_templates . ,(vconcat (mapcar #'vconcat (alist-get 'capture_templates case))))))
                  ,@(and (alist-get 'answers case)
                         `((answers . ,(vconcat (alist-get 'answers case)))))
                  ,@(and (alist-get 'files case) `((files . ,(alist-get 'files case))))
                  ,@(and (alist-get 'find case) `((find . ,(alist-get 'find case))))
                  ,@(and (alist-get 'disk case) `((disk . ,(alist-get 'disk case))))
                  ,@(and (alist-get 'message case) '((message . t)))
                  ,@(and (alist-get 'capf case) `((capf . ,(vconcat (alist-get 'capf case)))))
                  ,@(and (alist-get 'completions case) '((completions . t)))
                  ,@(and (alist-get 'displayed case) '((displayed . t)))
                  ,@(and (alist-get 'vars case) `((vars . ,(alist-get 'vars case))))
                  ,@(and (alist-get 'globals case)
                         `((globals . ,(mapcar (lambda (g) (cons (car g) (e8-oracle--json (cdr g))))
                                               (alist-get 'globals case)))))
                  ,@(and (alist-get 'lockfiles case) '((lockfiles . t)))))
        ,@(if (derived-mode-p 'dired-mode)
              ;; Sizes and dates differ between runs: compare marks and names.
              (let ((dired (e8-oracle--dired-normalize)))
                `((text . ,(car dired))
                  (visible . ,(car dired))
                  (point . ,(funcall (cdr dired) (point)))
                  (mark . ,(and (mark t) (funcall (cdr dired) (mark t))))))
            `((text . ,(buffer-substring-no-properties (point-min) (point-max)))
              (visible . ,(progn (e8-oracle--fontify) (e8-oracle--visible)))
              (point . ,(1- (point)))
              (mark . ,(and (mark t) (1- (mark t))))))
        (mark_active . ,(if (and mark-active (mark t)) t :json-false))
        (kill_ring . ,(vconcat (mapcar (lambda (k) (e8-oracle--without-dir (substring-no-properties k))) kill-ring)))
        (modified . ,(if (buffer-modified-p) t :json-false))
        (error . ,(e8-oracle--without-dir e8-oracle--error))
        ,@(and (alist-get 'windows case)
               `((windows . ,(e8-oracle--windows))))
        ,@(and (or (alist-get 'files case) (alist-get 'find case))
               `((files . ,(e8-oracle--listing))))
        ,@(and (alist-get 'message case)
               `((message . ,(e8-oracle--last-message))))
        ,@(and (alist-get 'displayed case)
               `((displayed . ,(e8-oracle--displayed))))
        ,@(and (alist-get 'completions case)
               `((completions . ,(let ((b (get-buffer "*Completions*")))
                                   (if (and b (get-buffer-window b 0))
                                       (with-current-buffer b
                                         (buffer-substring-no-properties (point-min) (point-max)))
                                     nil)))))))

(defun e8-oracle--displayed ()
  "The buffer as it is drawn: the text with each overlay's display string
in place of what it covers and the invisible text left out.  Not the
header line, which column view sets only from a post-command hook."
  (let ((out nil) (p (point-min)))
    (while (< p (point-max))
      (let ((ov (seq-find (lambda (o) (and (stringp (overlay-get o 'display)) (= (overlay-start o) p)))
                          (overlays-at p t))))
        (cond (ov (push (substring-no-properties (overlay-get ov 'display)) out)
                  (setq p (max (overlay-end ov) (1+ p))))
              ((invisible-p p) (setq p (1+ p)))
              (t (push (string (char-after p)) out) (setq p (1+ p))))))
    (apply #'concat (nreverse out))))

(defun e8-oracle--windows ()
  "The frame's windows in cyclic order: buffer, point and total size."
  (vconcat
   (mapcar (lambda (w)
             `((buffer . ,(buffer-name (window-buffer w)))
               (point . ,(1- (window-point w)))
               (width . ,(window-total-width w))
               (height . ,(window-total-height w))
               (selected . ,(if (eq w (selected-window)) t :json-false))))
           (window-list nil 'nomini (frame-first-window)))))

(defun e8-oracle--record-file (file golden-dir)
  "Run the cases in FILE and write their results into GOLDEN-DIR."
  (let* ((cases (let ((json-object-type 'alist)
                      (json-array-type 'list)
                      ;; In UTF-8, whatever coding the last case preferred.
                      (coding-system-for-read 'utf-8))
                  (json-read-file file)))
         (results (mapcar #'e8-oracle--run cases))
         (out (expand-file-name (file-name-nondirectory file) golden-dir))
         (json-encoding-pretty-print t)
         (coding-system-for-write 'utf-8-unix))
    (with-temp-file out
      (insert (json-encode `((emacs_version . ,emacs-version)
                             (system_type . ,(symbol-name system-type))
                             (cases . ,(vconcat results)))))
      (insert "\n"))
    (message "%s: %d cases" (file-name-nondirectory file) (length results))))

(let* ((dir (or (getenv "E8_ORACLE_DIR") (file-name-directory load-file-name)))
       (golden (expand-file-name "golden" dir)))
  (make-directory golden t)
  ;; Messages from the cases themselves go to stderr; keep the output to the summary.
  (let ((inhibit-message t))
    (dolist (file (directory-files (expand-file-name "cases" dir) t "\\.json\\'"))
      ;; E8_ORACLE_ONLY records only the case files whose names have it.
      (when (string-search (or (getenv "E8_ORACLE_ONLY") "") (file-name-nondirectory file))
        (let ((inhibit-message nil))
          (e8-oracle--record-file file golden))))))

;;; record.el ends here
