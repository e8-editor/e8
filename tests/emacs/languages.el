;;; languages.el --- Writes Emacs's language environments for E8  -*- lexical-binding: t -*-

;; Writes the table at the end of packages/mule.ts: each of Emacs's
;; language environments, newest first as `language-info-alist' holds
;; them, with what it says of itself that E8 can use: its documentation
;; (t for none), sample text, charsets, coding systems and their
;; priority, input method, nonascii translation, ISO 639 language and
;; tutorial. Setup and exit functions and features are Emacs's Lisp, so
;; mule.ts writes those it has itself.
;;
;;   emacs -Q --batch -l tests/emacs/languages.el

(require 'json)

(defconst e8-language-keys
  '(documentation sample-text charset coding-system coding-priority input-method
    nonascii-translation iso639-language tutorial)
  "The keys of `language-info-alist' E8 keeps.")

(defun e8--language-value (value)
  "VALUE as JSON: a symbol as its name, a list as an array of them."
  (cond ((eq value t) "true")
        ((null value) "null")
        ((symbolp value) (json-encode (symbol-name value)))
        ((stringp value) (json-encode value))
        ((listp value) (concat "[" (mapconcat #'e8--language-value value ", ") "]"))
        (t (json-encode value))))

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (out (expand-file-name "../packages/mule.ts" root))
       (marker "// The table below is written by tests/emacs/languages.el.\n"))
  (let ((coding-system-for-write 'utf-8-unix))
   (with-temp-file out
    (insert-file-contents out)
    (goto-char (point-min))
    (search-forward marker)
    (delete-region (point) (point-max))
    (insert "/** Emacs's language environments, newest first, each with what it says of itself, as language-info-alist holds them. */\n")
    (insert "function languages(): LanguageInfo[] {\n  return [\n")
    (dolist (lang language-info-alist)
      (insert (format "    [%s" (json-encode (car lang))))
      (dolist (entry (cdr lang))
        (when (memq (car entry) e8-language-keys)
          (let ((value (cdr entry)))
            ;; Sample text is an expression to evaluate, most often a string.
            ;; Emacs's own characters beyond Unicode are left out with it.
            (when (eq (car entry) 'sample-text)
              (setq value (condition-case nil (eval value t) (error nil)))
              (unless (and (stringp value) (seq-every-p (lambda (c) (<= c #x10ffff)) value))
                (setq value nil)))
            (when value
              (insert (format ", [%s, %s]" (json-encode (symbol-name (car entry))) (e8--language-value value)))))))
      (insert "],\n"))
    (insert "  ];\n}\n"))))
