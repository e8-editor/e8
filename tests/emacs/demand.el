;;; demand.el --- count the calls Emacs Lisp makes to primitives  -*- lexical-binding: t -*-

;; Run by demand.py, which says what it is for: once per chunk of the
;; corpus, as
;;
;;   emacs -Q --batch -l tests/emacs/demand.el MANIFEST OUT
;;
;; MANIFEST has one line per file, CORPUS TAB PACKAGE TAB PATH, each
;; package's files together.  Each file is read as forms with Emacs's own
;; reader, the features it requires that ship with Emacs are loaded, and
;; each form is macroexpanded with the macros Emacs defines.  The package's
;; own code is never evaluated: its macros are not defined (a use of one
;; reads as a call), `load-path' holds only Emacs's own directories, and the
;; macros that evaluate their arguments while expanding (`eval-when-compile',
;; `cl-macrolet', `static-if' and the like) are replaced by `progn'.
;;
;; OUT gets tab-separated records:
;;   C CORPUS PACKAGE SYMBOL N   calls of SYMBOL, a primitive, in the expanded code
;;   F CORPUS PACKAGE SYMBOL N   calls of SYMBOL, a function Emacs defines in Lisp
;;   M CORPUS PACKAGE MACRO N    uses of MACRO, a macro Emacs defines, in the source
;;   R CORPUS PACKAGE FEATURE N  a library that ships with Emacs required at run time
;;   X MACRO SYM SYM ...         functions one use of MACRO brings in by expanding, once per call
;;   W FILE FUNCTION SYM SYM ... functions a function defined in FILE calls
;;   E CORPUS PACKAGE PATH MSG   a file or form that could not be read or expanded

(require 'cl-lib)
(require 'macroexp)

(defvar demand--counts (make-hash-table :test 'equal))
(defvar demand--samples (make-hash-table :test 'eq)
  "How many uses of each macro have been expanded on their own for X records.")
(defvar demand--out nil)
(defvar demand--defun nil "The function being defined, for W records.")
(defvar demand--defun-calls nil)

(defconst demand--higher-order
  '((funcall . 1) (apply . 1) (mapcar . 1) (mapc . 1) (mapcan . 1) (mapconcat . 1)
    (maphash . 1) (mapatoms . 1) (map-keymap . 1) (map-char-table . 1)
    (call-interactively . 1) (funcall-interactively . 1) (apply-partially . 1)
    (seq-map . 1) (seq-do . 1) (seq-filter . 1) (seq-remove . 1) (seq-find . 1)
    (cl-remove-if . 1) (cl-remove-if-not . 1) (cl-find-if . 1) (cl-some . 1) (cl-every . 1)
    (add-hook . 2) (remove-hook . 2) (advice-add . 3) (advice-remove . 2)
    (run-with-timer . 3) (run-at-time . 3) (run-with-idle-timer . 3)
    (defalias . 2) (fset . 2) (sort . 2))
  "Functions taking a function, and which argument it is: a quoted symbol there is a call.")

(defconst demand--safe-env
  (let ((progn-of-rest (lambda (&rest body) (macroexp-progn body))))
    `((eval-when-compile . ,progn-of-rest)
      (eval-and-compile . ,progn-of-rest)
      (cl-eval-when . ,(lambda (_when &rest body) (macroexp-progn body)))
      (load-time-value . ,(lambda (form &optional _ro) form))
      (cl-load-time-value . ,(lambda (form &optional _ro) form))
      (static-if . ,(lambda (cond then &rest else) `(progn ,cond ,then ,@else)))
      (static-when . ,(lambda (cond &rest body) `(progn ,cond ,@body)))
      (static-unless . ,(lambda (cond &rest body) `(progn ,cond ,@body)))
      (cl-macrolet . ,(lambda (_defs &rest body) (macroexp-progn body)))
      (cl-symbol-macrolet . ,(lambda (_defs &rest body) (macroexp-progn body)))
      (rx . ,(lambda (&rest _) nil))
      (rx-let . ,(lambda (_defs &rest body) (macroexp-progn body)))
      (rx-let-eval . ,(lambda (_defs &rest body) (macroexp-progn body)))
      (rx-define . ,(lambda (&rest _) nil))))
  "Macros replaced while expanding, as they would run the package's code.")

(defun demand--emacs-macro-p (sym)
  "Non-nil if SYM is a macro Emacs defines, autoloaded or loaded."
  (and (symbolp sym) (not (assq sym demand--safe-env))
       (let ((def (indirect-function sym)))
         (or (eq (car-safe def) 'macro)
             (and (autoloadp def) (memq (nth 4 def) '(macro t)))))))

(defun demand--count (kind corpus package sym)
  (let ((key (list kind corpus package sym)))
    (puthash key (1+ (gethash key demand--counts 0)) demand--counts)))

(defun demand--called (sym corpus package)
  "Record a call of SYM."
  (when (and (symbolp sym) sym (fboundp sym))
    (if (subr-primitive-p (symbol-function sym))
        (demand--count "C" corpus package sym)
      (unless (macrop sym) (demand--count "F" corpus package sym)))
    (when demand--defun (push sym demand--defun-calls))))

(defun demand--walk-body (forms corpus package)
  (while (consp forms)
    (demand--walk (car forms) corpus package)
    (setq forms (cdr forms))))

(defun demand--walk-lambda (fn corpus package)
  "Walk (lambda ARGS . BODY)."
  (demand--walk-body (cddr fn) corpus package))

(defun demand--walk (form corpus package)
  "Count the calls in FORM, code with every macro Emacs defines expanded."
  (when (consp form)
    (let ((head (car form)) (args (cdr form)))
      (pcase head
        ('quote nil)
        ('function
         (let ((f (car-safe args)))
           (cond ((symbolp f) (demand--called f corpus package))
                 ((eq (car-safe f) 'lambda) (demand--walk-lambda f corpus package)))))
        ((or 'let 'let*)
         (dolist (b (and (listp (car-safe args)) (car args)))
           (when (consp b) (demand--walk-body (cdr b) corpus package)))
         (demand--walk-body (cdr-safe args) corpus package))
        ('cond (dolist (clause args) (when (listp clause) (demand--walk-body clause corpus package))))
        ('condition-case
         (demand--walk (car-safe (cdr-safe args)) corpus package)
         (dolist (h (cdr-safe (cdr-safe args))) (when (consp h) (demand--walk-body (cdr h) corpus package))))
        ((or 'defvar 'defconst) (demand--walk (car-safe (cdr-safe args)) corpus package))
        ('setq (let ((rest args))
                 (while (consp rest) (demand--walk (car-safe (cdr rest)) corpus package) (setq rest (cddr rest)))))
        ('defalias
         ;; (defalias 'NAME (function (lambda ...))): the calls in it are NAME's, for W records.
         (let ((name (and (eq (car-safe (car-safe args)) 'quote) (cadr (car args))))
               (outer demand--defun) (outer-calls demand--defun-calls))
           (if (and name (symbolp name) (eq (car-safe (cadr args)) 'function)
                    (eq (car-safe (cadr (cadr args))) 'lambda))
               (progn
                 (setq demand--defun name demand--defun-calls nil)
                 (demand--walk-body args corpus package)
                 (when (string= corpus "emacs")
                   (push (cons name demand--defun-calls) (get 'demand--defuns 'list)))
                 (setq demand--defun outer demand--defun-calls outer-calls))
             (demand--called 'defalias corpus package)
             (demand--walk-body args corpus package))))
        ((pred symbolp)
         (demand--called head corpus package)
         (let ((pos (cdr (assq head demand--higher-order))) (i 1))
           (dolist (a (if (proper-list-p args) args nil))
             (when (and pos (= i pos) (eq (car-safe a) 'quote) (symbolp (demand--cadr a)))
               (demand--called (cadr a) corpus package))
             (setq i (1+ i))))
         (demand--walk-body args corpus package))
        (_ (demand--walk head corpus package)
           (demand--walk-body args corpus package))))))

(defun demand--cadr (x) (car-safe (cdr-safe x)))

(defun demand--source-heads (form acc)
  "The heads of FORM's subforms, read loosely, as source with no macros expanded."
  (when (and (consp form) (not (eq (car form) 'quote)))
    (when (symbolp (car form)) (push (car form) (car acc)))
    (let ((rest form))
      (while (consp rest) (demand--source-heads (car rest) acc) (setq rest (cdr rest)))))
  acc)

(defun demand--expanded-heads (form)
  (let ((acc (list nil)) (demand--defun nil))
    (cl-letf (((symbol-function 'demand--called)
               (lambda (sym &rest _) (when (and (symbolp sym) sym (fboundp sym)) (push sym (car acc))))))
      (demand--walk form nil nil))
    (car acc)))

(defun demand--minus (list other)
  "LIST without OTHER's elements, each taken out as many times as OTHER has it."
  (dolist (x other) (setq list (delq nil (let ((done nil)) (mapcar (lambda (y) (if (and (not done) (eq x y)) (progn (setq done t) nil) y)) list)))))
  list)

(defun demand--macros (form corpus package)
  "Count the uses of Emacs's macros in FORM, and expand a few on their own."
  (when (and (consp form) (not (eq (car form) 'quote)))
    (let ((head (car form)))
      (when (demand--emacs-macro-p head)
        (demand--count "M" corpus package head)
        (when (< (gethash head demand--samples 0) 8)
          (puthash head (1+ (gethash head demand--samples 0)) demand--samples)
          (ignore-errors
            (let* ((expanded (let ((lexical-binding t)) (macroexpand-all form demand--safe-env)))
                   (before (car (demand--source-heads (cdr form) (list nil))))
                   (brought (demand--minus (demand--expanded-heads expanded) before)))
              (princ (format "X\t%s\t%s\n" head (mapconcat #'symbol-name (sort brought #'string<) "\t"))
                     demand--out))))))
    (let ((rest form))
      (while (consp rest) (demand--macros (car rest) corpus package) (setq rest (cdr rest))))))

(defun demand--read-file (path)
  "The forms in PATH, and an error message if reading stopped early."
  (with-temp-buffer
    (insert-file-contents path)
    (goto-char (point-min))
    (let (forms err)
      (condition-case e
          (while t
            (push (read (current-buffer)) forms))
        (end-of-file nil)
        (error (setq err (format "%S at %d" e (point)))))
      (cons (nreverse forms) err))))

(defun demand--requires (forms corpus package &optional compile-time)
  "Load the features FORMS require that ship with Emacs, and record the ones needed at run time."
  (dolist (f forms)
    (pcase f
      (`(require (quote ,feature) . ,_)
       (when (and (symbolp feature) (locate-library (symbol-name feature)))
         (unless compile-time (demand--count "R" corpus package feature))
         (unless (featurep feature)
           (ignore-errors (let ((inhibit-message t)) (require feature nil t))))))
      (`(eval-when-compile . ,body) (demand--requires body corpus package t))
      (`(eval-and-compile . ,body) (demand--requires body corpus package compile-time)))))

(defun demand--file (corpus package path)
  (let* ((read (demand--read-file path)) (forms (car read)))
    (when (cdr read)
      (princ (format "E\t%s\t%s\t%s\t%s\n" corpus package path (cdr read)) demand--out))
    (demand--requires forms corpus package)
    (put 'demand--defuns 'list nil)
    (dolist (form forms)
      (demand--macros form corpus package)
      (condition-case e
          (demand--walk (let ((lexical-binding t)) (macroexpand-all form demand--safe-env)) corpus package)
        (error
         (princ (format "E\t%s\t%s\t%s\t%s\n" corpus package path
                        (replace-regexp-in-string "[\t\n]" " " (format "%S" e)))
                demand--out)
         ;; Unexpanded, read as calls throughout.
         (dolist (h (car (demand--source-heads form (list nil))))
           (demand--called h corpus package)))))
    (dolist (d (get 'demand--defuns 'list))
      (princ (format "W\t%s\t%s\t%s\n" (file-name-nondirectory path) (car d)
                     (mapconcat #'symbol-name (delete-dups (cdr d)) "\t"))
             demand--out))))

(defun demand-main ()
  (let* ((manifest (nth 0 command-line-args-left))
         (out (nth 1 command-line-args-left))
         (default-directory temporary-file-directory)
         (enable-local-variables nil)
         (lines (with-temp-buffer (insert-file-contents manifest) (split-string (buffer-string) "\n" t))))
    (setq command-line-args-left nil)
    (with-temp-buffer
      (setq demand--out (current-buffer))
      (dolist (line lines)
        (pcase-let ((`(,corpus ,package ,path) (split-string line "\t")))
          (condition-case e
              (demand--file corpus package path)
            (error (princ (format "E\t%s\t%s\t%s\t%S\n" corpus package path e) demand--out)))))
      (maphash (lambda (k n)
                 (princ (format "%s\t%s\t%s\t%s\t%d\n" (nth 0 k) (nth 1 k) (nth 2 k) (nth 3 k) n) demand--out))
               demand--counts)
      (let ((coding-system-for-write 'utf-8-unix))
        (write-region nil nil out)))))

(demand-main)

;;; demand.el ends here
