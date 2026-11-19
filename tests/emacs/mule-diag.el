;;; mule-diag.el --- Writes how Emacs describes E8's coding systems  -*- lexical-binding: t -*-

;; Writes the table at the end of packages/mule-diag.ts: for each of
;; E8's coding systems, its mnemonic, its aliases, and what
;; `describe-coding-system' says of it, split where the end-of-line
;; conversion goes, so the commands show what Emacs shows:
;;
;;   emacs -Q --batch -l tests/emacs/mule-diag.el

(require 'json)

(defconst e8-coding-systems
  '(undecided prefer-utf-8 utf-8 utf-8-with-signature utf-8-auto utf-8-emacs utf-16 utf-16le utf-16be
    utf-16le-with-signature utf-16be-with-signature us-ascii iso-latin-1 iso-latin-2 iso-latin-3 iso-latin-4
    cyrillic-iso-8bit greek-iso-8bit hebrew-iso-8bit iso-latin-5 iso-latin-6 thai-tis620 iso-8859-11 iso-latin-7
    iso-latin-8 iso-latin-9 iso-latin-10 windows-1250 windows-1251 windows-1252 windows-1253 windows-1254
    windows-1255 windows-1256 windows-1257 windows-1258 cp874 cp866 cyrillic-koi8 koi8-u mac-roman
    japanese-shift-jis japanese-cp932 japanese-iso-8bit iso-2022-jp iso-2022-7bit chinese-iso-8bit chinese-gbk
    chinese-gb18030 chinese-big5 chinese-big5-hkscs korean-iso-8bit korean-cp949 raw-text no-conversion
    no-conversion-multibyte)
  "The coding systems in crates/e8-core/src/coding.rs.")

(defun e8--description (coding)
  "What describe-coding-system shows for CODING, without its first line."
  (when (get-buffer "*Help*") (kill-buffer "*Help*"))
  (describe-coding-system coding)
  (with-current-buffer "*Help*"
    (let ((text (buffer-substring-no-properties (point-min) (point-max))))
      (substring text (1+ (string-search "\n" text))))))

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (out (expand-file-name "../packages/mule-diag.ts" root))
       (marker "// The table below is written by tests/emacs/mule-diag.el.\n")
       (entries
        (mapcar
         (lambda (coding)
           (let* ((text (e8--description coding))
                  (eol (string-match "^EOL type: .*\n\\(\t\\[.*\\]\n\\)?" text)))
             (list (symbol-name coding)
                   (string (coding-system-mnemonic coding))
                   (mapcar #'symbol-name (coding-system-aliases coding))
                   (substring text 0 eol)
                   (substring text (match-end 0)))))
         e8-coding-systems)))
  (with-temp-file out
    (insert-file-contents out)
    (goto-char (point-min))
    (search-forward marker)
    (delete-region (point) (point-max))
    (insert "/** For each coding system: its mnemonic, its aliases, and Emacs's description before and after the line on its end-of-line conversion. */\n")
    (insert "const DESCRIPTIONS: Record<string, [string, string[], string, string]> = {\n")
    (dolist (e entries)
      (insert (format "  %s: [%s, [%s], %s, %s],\n"
                      (json-encode (nth 0 e)) (json-encode (nth 1 e))
                      (mapconcat #'json-encode (nth 2 e) ", ")
                      (json-encode (nth 3 e)) (json-encode (nth 4 e)))))
    (insert "};\n")))
