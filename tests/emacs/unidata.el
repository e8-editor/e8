;;; unidata.el --- Writes Emacs's Unicode character properties for E8  -*- lexical-binding: t -*-

;; Writes what `get-char-code-property' gives in Emacs 30.2 for the
;; properties E8 had no data for:
;;
;; - crates/e8-core/src/unidata_names.txt: each character's `name' that
;;   is not made from its code, as UNICODE-NAME-HEX is, and each `old-name'.
;;   The names are in code order, each line the distance from the last
;;   code in hex (empty for 1), how many characters it shares with the last
;;   name, and the rest of the name, separated by `;'; then a line `%' and
;;   the old names, each a hex code, `;' and the name.
;;
;; - crates/e8-core/src/unidata_data.rs: the runs of codes whose name is
;;   a prefix and the code in hex, each character's
;;   `canonical-combining-class', `decomposition', `decimal-digit-value',
;;   `digit-value', `numeric-value', `uppercase', `lowercase' and
;;   `titlecase' where it has one, and what `char-code-property-description'
;;   says of the values of general-category, canonical-combining-class,
;;   bidi-class and bracket-type.
;;
;; - tests/emacs/unidata-props.txt: every property of some characters
;;   and what char-from-name gives for some names, for
;;   crates/e8-script/tests/all/unicode_names.rs to compare E8 with.
;;
;;   emacs -Q --batch -l tests/emacs/unidata.el

(defun e8--rust-string (s)
  "S as a Rust string literal."
  (concat "\"" (mapconcat (lambda (c) (cond ((eq c ?\") "\\\"") ((eq c ?\\) "\\\\") ((< c 32) (format "\\u{%x}" c)) (t (string c)))) s "") "\""))

(defun e8--shared (a b)
  "How many characters A and B start with in common."
  (let ((i 0) (n (min (length a) (length b))))
    (while (and (< i n) (eq (aref a i) (aref b i))) (setq i (1+ i)))
    i))

(defun e8--hangul-p (c) (and (>= c #xAC00) (<= c #xD7A3)))

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (names-file (expand-file-name "../crates/e8-core/src/unidata_names.txt" root))
       (data-file (expand-file-name "../crates/e8-core/src/unidata_data.rs" root))
       (coding-system-for-write 'utf-8-unix)
       (last-code -1) (last-name "")
       (acc (make-hash-table))
       algorithmic old-names ccc decompositions)
  (with-temp-file names-file
    (dotimes (c #x110000)
      (let ((name (get-char-code-property c 'name))
            (old (get-char-code-property c 'old-name))
            (suffix (format "-%X" c)))
        (when (and old (not (string-empty-p old))) (push (cons c old) old-names))
        (cond
         ((or (null name) (string-empty-p name) (e8--hangul-p c)))
         ((string-suffix-p suffix name)
          (let ((prefix (substring name 0 (- (length name) (length suffix)))))
            (if (and algorithmic (equal (nth 2 (car algorithmic)) prefix) (= (nth 1 (car algorithmic)) (1- c)))
                (setcar (cdr (car algorithmic)) c)
              (push (list c c prefix) algorithmic))))
         (t
          (let ((shared (e8--shared last-name name)))
            (insert (if (= c (1+ last-code)) "" (format "%X" (- c last-code)))
                    ";" (number-to-string shared) ";" (substring name shared) "\n")
            (setq last-code c last-name name)))))
      (let ((v (get-char-code-property c 'canonical-combining-class)))
        (when (and v (/= v 0))
          (if (and ccc (= (nth 2 (car ccc)) v) (= (nth 1 (car ccc)) (1- c)))
              (setcar (cdr (car ccc)) c)
            (push (list c c v) ccc))))
      (let ((d (get-char-code-property c 'decomposition)))
        (unless (or (null d) (equal d (list c)))
          (push (cons c d) decompositions)))
      (dolist (p '(decimal-digit-value digit-value numeric-value))
        (let ((v (get-char-code-property c p)))
          (when v (push (cons c v) (gethash p acc)))))
      (dolist (p '(uppercase lowercase titlecase))
        (let ((v (get-char-code-property c p)))
          (when (and v (/= v c)) (push (cons c v) (gethash p acc))))))
    (insert "%\n")
    (dolist (o (nreverse old-names))
      (insert (format "%X;%s\n" (car o) (cdr o)))))
  (with-temp-file data-file
    (insert "//! Unicode character properties from GNU Emacs 30.2, written by\n"
            "//! tests/emacs/unidata.el, as `get-char-code-property' gives them; the\n"
            "//! names are in unidata_names.txt beside it.\n\n")
    (insert "/// Runs of characters named by a prefix and their code in hex, as\n/// CJK IDEOGRAPH-4E00: first, last, prefix.\n")
    (insert "pub(crate) const ALGORITHMIC_NAMES: &[(u32, u32, &str)] = &[\n")
    (dolist (a (reverse algorithmic)) (insert (format "    (%d, %d, %s),\n" (nth 0 a) (nth 1 a) (e8--rust-string (nth 2 a)))))
    (insert "];\n\n/// Runs of characters with a canonical combining class other than 0: first, last, class.\n")
    (insert "pub(crate) const COMBINING_CLASS: &[(u32, u32, u8)] = &[\n")
    (dolist (a (reverse ccc)) (insert (format "    (%d, %d, %d),\n" (nth 0 a) (nth 1 a) (nth 2 a))))
    (insert "];\n\n/// Characters that decompose: the character, the decomposition's tag\n/// (empty for a canonical one), and the characters it decomposes into.\n")
    (insert "pub(crate) const DECOMPOSITION: &[(u32, &str, &[u32])] = &[\n")
    (dolist (d (nreverse decompositions))
      (let* ((v (cdr d)) (tag (and (symbolp (car v)) (car v))) (chars (if tag (cdr v) v)))
        (insert (format "    (%d, %s, &[%s]),\n" (car d) (e8--rust-string (if tag (symbol-name tag) ""))
                        (mapconcat #'number-to-string chars ", ")))))
    (dolist (table '(("DECIMAL_DIGIT_VALUE" "decimal-digit-value" decimal-digit-value "u8")
                     ("DIGIT_VALUE" "digit-value" digit-value "u8")))
      (insert (format "];\n\n/// Each character's `%s'.\npub(crate) const %s: &[(u32, %s)] = &[\n" (nth 1 table) (nth 0 table) (nth 3 table)))
      (dolist (v (reverse (gethash (nth 2 table) acc))) (insert (format "    (%d, %d),\n" (car v) (cdr v)))))
    (insert "];\n\n/// Each character's `numeric-value'.\npub(crate) const NUMERIC_VALUE: &[(u32, f64)] = &[\n")
    (dolist (v (reverse (gethash 'numeric-value acc))) (insert (format "    (%d, %s),\n" (car v) (let ((s (number-to-string (cdr v)))) (if (string-match-p "[.e]" s) s (concat s ".0"))))))
    (dolist (table '(("UPPERCASE" "uppercase" uppercase) ("LOWERCASE" "lowercase" lowercase) ("TITLECASE" "titlecase" titlecase)))
      (insert (format "];\n\n/// Each character's `%s' where it is another character.\npub(crate) const %s: &[(u32, u32)] = &[\n" (nth 1 table) (nth 0 table)))
      (dolist (v (reverse (gethash (nth 2 table) acc))) (insert (format "    (%d, %d),\n" (car v) (cdr v)))))
    (insert "];\n\n/// What `char-code-property-description' says of the values of\n/// general-category, canonical-combining-class, bidi-class and\n/// bracket-type: property, value, description.\n")
    (insert "pub(crate) const DESCRIPTIONS: &[(&str, &str, &str)] = &[\n")
    (dolist (p '(general-category canonical-combining-class bidi-class bracket-type))
      (let ((vals (make-hash-table :test 'equal)) (order nil))
        (dotimes (c #x110000)
          (let ((v (get-char-code-property c p)))
            (when (and v (not (gethash v vals))) (puthash v t vals) (push v order))))
        (dolist (v (sort order (lambda (a b) (string< (format "%s" a) (format "%s" b)))))
          (let ((desc (ignore-errors (char-code-property-description p v))))
            (when desc
              (insert (format "    (%s, %s, %s),\n" (e8--rust-string (symbol-name p)) (e8--rust-string (format "%s" v)) (e8--rust-string desc))))))))
    (insert "];\n")))

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (coding-system-for-write 'utf-8-unix)
       (out nil))
  (dolist (c '(?a ?A ?é ?½ #x300 #x5d0 #x661 #x2160 #xAC01 #x4E00 #x1F600 ?ß #x130 ?\( #x10FFFF 7))
    (dolist (p (reverse (mapcar #'car char-code-property-alist)))
      (push (format "%X %s %S" c p (get-char-code-property c p)) out)))
  (dolist (n '("LATIN SMALL LETTER A" "latin small letter a" "BELL" "BELL (BEL)" "VARIATION SELECTOR-17"
               "CJK COMPATIBILITY IDEOGRAPH-F900" "CJK IDEOGRAPH-4E00" "GREEK SMALL LETTER LAMBDA"
               "GREEK SMALL LETTER LAMDA" "HANGUL SYLLABLE GA" "NOPE"))
    (push (format "from %s %S %S" n (char-from-name n) (char-from-name n t)) out))
  (with-temp-file (expand-file-name "emacs/unidata-props.txt" root)
    (insert (string-join (nreverse out) "\n") "\n")))
