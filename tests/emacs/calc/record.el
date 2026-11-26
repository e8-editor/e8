;;; record.el --- Record what Calc gives Org's table formulas  -*- lexical-binding: t -*-

;; Run from the repository's root:
;;
;;   emacs -Q --batch -l tests/emacs/calc/record.el
;;
;; Each case in cases.json is a list of Calc modes, as a plist that
;; changes Org's `org-calc-default-modes', a formula, and optionally
;; "num", for the separator Org passes with its N flag.  The result of
;; `calc-eval' for each goes in golden.json: the string Calc writes, or for
;; an error, its message.

(require 'calc)
(require 'org-table)
(require 'json)

(defun e8-calc--symbols (x)
  "X from JSON, its strings as symbols and its vectors as lists."
  (cond ((stringp x) (intern x))
        ((vectorp x) (mapcar #'e8-calc--symbols x))
        (t x)))

(let* ((dir (file-name-directory load-file-name))
       (cases (json-parse-string
               (with-temp-buffer
                 (insert-file-contents (expand-file-name "cases.json" dir))
                 (buffer-string))
               :array-type 'array :null-object nil :false-object nil))
       (results
        (mapcar
         (lambda (case)
           (let* ((modes (copy-sequence org-calc-default-modes))
                  (changes (append (aref case 0) nil))
                  (formula (aref case 1))
                  (num (and (> (length case) 2) (equal (aref case 2) "num"))))
             (while changes
               (setq modes (plist-put modes (intern (car changes))
                                      (e8-calc--symbols (cadr changes))))
               (setq changes (cddr changes)))
             (let ((r (calc-eval (cons formula modes) (and num 'num))))
               `((modes . ,(aref case 0))
                 (formula . ,formula)
                 (num . ,(if num t :json-false))
                 (result . ,(if (stringp r) r `((error . ,(nth 1 r)))))))))
         (append cases nil))))
  (with-temp-file (expand-file-name "golden.json" dir)
    (insert (json-encode (vconcat results)))
    (json-pretty-print-buffer)
    (insert "\n"))
  (message "Recorded %d Calc cases" (length results)))

;;; record.el ends here
