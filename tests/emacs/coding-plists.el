;;; coding-plists.el --- Writes what Emacs's codings and charsets say of themselves  -*- lexical-binding: t -*-

;; Writes two tables in E8's Rust from Emacs's plists, so
;; `coding-system-plist' and `charset-plist' give what Emacs's do:
;; EMACS_SYSTEMS in crates/e8-core/src/coding.rs, each coding system's
;; docstring, category and charset list, and EMACS_CHARSETS in
;; crates/e8-core/src/charset.rs, each charset's docstring, short and
;; long names, emacs-mule id and unification map:
;;
;;   emacs -Q --batch -l tests/emacs/coding-plists.el

(defconst e8-plist-coding-systems
  '(undecided prefer-utf-8 utf-8 utf-8-with-signature utf-8-auto utf-8-emacs utf-16 utf-16le utf-16be
    utf-16le-with-signature utf-16be-with-signature us-ascii iso-latin-1 iso-latin-2 iso-latin-3 iso-latin-4
    cyrillic-iso-8bit greek-iso-8bit hebrew-iso-8bit iso-latin-5 iso-latin-6 thai-tis620 iso-8859-11 iso-latin-7
    iso-latin-8 iso-latin-9 iso-latin-10 windows-1250 windows-1251 windows-1252 windows-1253 windows-1254
    windows-1255 windows-1256 windows-1257 windows-1258 cp874 cp866 cyrillic-koi8 koi8-u mac-roman
    japanese-shift-jis japanese-cp932 japanese-iso-8bit iso-2022-jp iso-2022-7bit chinese-iso-8bit chinese-gbk
    chinese-gb18030 chinese-big5 chinese-big5-hkscs korean-iso-8bit korean-cp949 raw-text no-conversion
    no-conversion-multibyte)
  "The coding systems in crates/e8-core/src/coding.rs.")

(defconst e8-plist-charsets
  '(ascii iso-8859-1 unicode latin-iso8859-1 iso-8859-2 latin-iso8859-2 iso-8859-3 latin-iso8859-3 iso-8859-4
    latin-iso8859-4 iso-8859-5 cyrillic-iso8859-5 iso-8859-7 greek-iso8859-7 iso-8859-8 hebrew-iso8859-8
    iso-8859-9 latin-iso8859-9 iso-8859-10 latin-iso8859-10 iso-8859-11 thai-iso8859-11 iso-8859-13
    latin-iso8859-13 iso-8859-14 latin-iso8859-14 iso-8859-15 latin-iso8859-15 iso-8859-16 latin-iso8859-16
    thai-tis620 chinese-gb2312 chinese-gbk big5 japanese-jisx0208 japanese-jisx0212 korean-ksc5601 koi8-r cp866
    koi8-u windows-1250 windows-1251 windows-1252 windows-1253 windows-1254 windows-1255 windows-1256
    windows-1257 windows-1258 cp874 unicode-bmp mac-roman emacs eight-bit katakana-jisx0201)
  "The charsets in crates/e8-core/src/charset.rs.")

(defun e8--rust-string (s)
  "S as a Rust string literal."
  (concat "\"" (replace-regexp-in-string "\n" "\\\\n" (replace-regexp-in-string "[\"\\]" "\\\\\\&" (or s ""))) "\""))

(defun e8--replace-table (file name rows)
  "Replace the static table NAME in FILE, from its line to its `];', with ROWS."
  (let ((coding-system-for-write 'utf-8-unix))
    (with-temp-file file
      (insert-file-contents file)
      (goto-char (point-min))
      (search-forward (format "static %s:" name))
      (beginning-of-line)
      (let ((start (point)))
        (search-forward "\n];\n")
        (delete-region start (point)))
      (insert rows))))

(let ((root (file-name-directory (directory-file-name (file-name-directory load-file-name)))))
  (e8--replace-table
   (expand-file-name "../crates/e8-core/src/coding.rs" root) "EMACS_SYSTEMS"
   (concat "static EMACS_SYSTEMS: &[(&str, &str, &str, &[&str])] = &[\n"
           (mapconcat
            (lambda (coding)
              (let ((charsets (coding-system-get coding :charset-list)))
                (format "    (%s, %s, %s, &[%s]),\n"
                        (e8--rust-string (symbol-name coding))
                        (e8--rust-string (coding-system-get coding :docstring))
                        (e8--rust-string (symbol-name (coding-system-get coding :category)))
                        ;; iso-2022-7bit's is a symbol, iso-2022, the rest lists.
                        (mapconcat (lambda (c) (e8--rust-string (symbol-name c)))
                                   (if (listp charsets) charsets (list charsets)) ", "))))
            e8-plist-coding-systems "")
           "];\n"))
  (e8--replace-table
   (expand-file-name "../crates/e8-core/src/charset.rs" root) "EMACS_CHARSETS"
   (concat "static EMACS_CHARSETS: &[EmacsCharset] = &[\n"
           (mapconcat
            (lambda (charset)
              (let ((plist (charset-plist charset)))
                (format "    (%s, %s, %s, %s, %s, %s),\n"
                        (e8--rust-string (symbol-name charset))
                        (e8--rust-string (plist-get plist :docstring))
                        (e8--rust-string (plist-get plist :short-name))
                        (e8--rust-string (plist-get plist :long-name))
                        (if (plist-get plist :emacs-mule-id) (format "Some(%d)" (plist-get plist :emacs-mule-id)) "None")
                        (if (plist-get plist :unify-map) (format "Some(%s)" (e8--rust-string (plist-get plist :unify-map))) "None"))))
            e8-plist-charsets "")
           "];\n")))
