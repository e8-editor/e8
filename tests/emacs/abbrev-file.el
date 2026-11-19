;;; abbrev-file.el --- Writes an abbrev file with Emacs, for E8  -*- lexical-binding: t -*-

;; Defines some abbrevs and writes them with `write-abbrev-file' to
;; tests/emacs/abbrev_defs, for crates/e8-script/tests/all/abbrevs.rs to
;; compare what E8 writes for the same abbrevs with, and to read back.
;;
;;   emacs -Q --batch -l tests/emacs/abbrev-file.el

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (file (expand-file-name "emacs/abbrev_defs" root)))
  (require 'text-mode)
  (define-abbrev global-abbrev-table "afaik" "as far as I know")
  (define-abbrev global-abbrev-table "q" "say \"hi\" \\ there")
  (define-abbrev text-mode-abbrev-table "teh" "the")
  (define-abbrev text-mode-abbrev-table "smorg" "smörgåsbord")
  (abbrev-put (abbrev--symbol "teh" text-mode-abbrev-table) :count 3)
  (write-abbrev-file file))
