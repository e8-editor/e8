;;; ansi-color.el --- Writes what Emacs's ansi-color does, for E8  -*- lexical-binding: t -*-

;; Writes tests/emacs/ansi-color.txt: for each case, chunks of program
;; output given in turn to `ansi-color-apply', `ansi-color-filter-apply',
;; `ansi-color-apply-on-region' (with `ansi-color-apply-text-property-face')
;; and `ansi-color-filter-region', and the text and faces that result, for
;; crates/e8-script/tests/all/ansi_color.rs to compare E8 with.
;;
;; Each case is a line `case NAME', a tab, t if `ansi-color-bold-is-bright'
;; is on for it, a tab and the chunks as a JSON array, then one line per
;; function: its name,
;; a tab, and the result as runs of text, each the text in quotes and its
;; face, separated by ` | '.  Faces are printed as Lisp prints them, with
;; symbols bare and strings quoted.
;;
;;   emacs -Q --batch -l tests/emacs/ansi-color.el

(require 'ansi-color)
(require 'json)

(defconst e8--ansi-cases
  '(("plain" "no colours here")
    ("red" "\e[31mred\e[0m plain")
    ("bold-red-on-blue" "\e[1;31;44mx\e[mn")
    ("bright" "\e[91mbr\e[101mbg\e[39mfg\e[49m.")
    ("basic" "\e[1mb\e[2mf\e[3mi\e[4mu\e[5ms\e[6mq\e[7mr\e[0m.")
    ("unset" "\e[1;3;4;7mall\e[22mnb\e[23mni\e[24mnu\e[27mnr\e[25m.")
    ("bold-off-21" "\e[1;4mx\e[21my\e[0m")
    ("clear-codes" "\e[31mx\e[8my\e[31mz\e[20mw\e[31mv\e[50mu")
    ("256" "\e[38;5;196ma\e[48;5;21mb\e[38;5;244mc\e[38;5;3md\e[38;5;11me\e[0m")
    ("cube" "\e[38;5;16ma\e[38;5;67mb\e[38;5;231mc\e[38;5;232md\e[38;5;255me")
    ("rgb" "\e[38;2;255;128;0mo\e[48;2;0;0;0mk\e[0m")
    ("bad-256" "\e[31mx\e[38;5;300my\e[0m")
    ("bad-rgb" "\e[31mx\e[38;2;1;2mz")
    ("bad-38" "\e[31mx\e[38;7my")
    ("empty-params" "\e[;31mx\e[31;mY\e[m.")
    ("other-sequences" "a\e[Kb\e[2Jc\e[?25hd\e[1;1He")
    ("split-sequence" "\e[3" "1mred" "\e[" "0m" "plain")
    ("split-escape" "a\e" "[32mgreen" "\e[1" ";4mbold")
    ("carry-on" "\e[33myellow" " still" "\e[0m done")
    ("trailing-escape" "x\e")
    ("lone-escape" "a\eb\e(Bc")
    ("fragment-then-sequence" "\e[\e[0m" "x")
    ("wide-characters" "é\e[31mλ😀" "ü\e[0mx" "\e[44m🙂")
    ("bold-is-bright" :bright "\e[1;31mx\e[22my\e[1;41mz")
    ("bright-with-bold" :bright "\e[1;91mx\e[0;1;38;5;1my")))

(defun e8--ansi-print (v)
  "V as a string, symbols bare and strings quoted."
  (cond ((null v) "nil")
        ((stringp v) (prin1-to-string v))
        ((symbolp v) (symbol-name v))
        ((consp v) (concat "(" (mapconcat #'e8--ansi-print v " ") ")"))
        (t (prin1-to-string v))))

(defun e8--ansi-runs (s prop)
  "The runs of S by PROP, each the text quoted and its value, a run
going on while the value prints the same."
  (let ((i 0) (out nil))
    (while (< i (length s))
      (let* ((face (e8--ansi-print (get-text-property i prop s)))
             (next (or (next-single-property-change i prop s) (length s))))
        (while (and (< next (length s))
                    (equal (e8--ansi-print (get-text-property next prop s)) face))
          (setq next (or (next-single-property-change next prop s) (length s))))
        (push (concat (prin1-to-string (substring-no-properties s i next)) " " face) out)
        (setq i next)))
    (mapconcat #'identity (nreverse out) " | ")))

(let* ((root (file-name-directory (directory-file-name (file-name-directory load-file-name))))
       (coding-system-for-write 'utf-8-unix)
       (out nil))
  (dolist (c e8--ansi-cases)
    (let* ((name (car c))
           (bright (eq (cadr c) :bright))
           (chunks (if bright (cddr c) (cdr c)))
           (ansi-color-bold-is-bright bright))
      (push (format "case %s\t%s\t%s" name (if bright "t" "nil") (json-encode (vconcat chunks))) out)
      (with-temp-buffer
        (setq ansi-color-context nil)
        (push (concat "ansi-color-apply\t"
                      (e8--ansi-runs (mapconcat #'ansi-color-apply chunks "") 'font-lock-face))
              out))
      (with-temp-buffer
        (setq ansi-color-context nil)
        (push (concat "ansi-color-filter-apply\t"
                      (e8--ansi-runs (mapconcat #'ansi-color-filter-apply chunks "") 'font-lock-face))
              out))
      (with-temp-buffer
        (let ((ansi-color-apply-face-function #'ansi-color-apply-text-property-face))
          (dolist (chunk chunks)
            (let ((start (point-max)))
              (goto-char (point-max))
              (insert chunk)
              (ansi-color-apply-on-region start (point-max))))
          (push (concat "ansi-color-apply-on-region\t"
                        (e8--ansi-runs (buffer-string) 'font-lock-face))
                out)))
      (with-temp-buffer
        (dolist (chunk chunks)
          (let ((start (point-max)))
            (goto-char (point-max))
            (insert chunk)
            (ansi-color-filter-region start (point-max))))
        (push (concat "ansi-color-filter-region\t" (e8--ansi-runs (buffer-string) 'font-lock-face))
              out))))
  (with-temp-file (expand-file-name "emacs/ansi-color.txt" root)
    (insert (mapconcat #'identity (nreverse out) "\n") "\n")))
