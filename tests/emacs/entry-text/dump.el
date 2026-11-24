;;; dump.el --- Dump what Org's entry text mode shows under agenda lines.  -*- lexical-binding: t -*-
;; Usage: emacs -Q --batch -l dump.el FILE.org MAXLINES [LEADER] [EXCLUDE-RE]
;; Prints each agenda line, then the after-string of the entry text
;; overlay on it, if any, as JSON lines.

(require 'org)
(require 'org-agenda)
(require 'json)

(let* ((args command-line-args-left)
       (file (expand-file-name (nth 0 args)))
       (maxlines (string-to-number (nth 1 args)))
       (leader (nth 2 args))
       (exclude (nth 3 args)))
  (setq command-line-args-left nil)
  (setq org-agenda-files (list file)
        org-agenda-span 'week
        org-agenda-start-day "2026-10-26"
        org-agenda-start-on-weekday 1
        org-agenda-use-time-grid nil
        org-agenda-window-setup 'current-window
        org-agenda-entry-text-maxlines maxlines)
  (when (and leader (not (equal leader ""))) (setq org-agenda-entry-text-leaders leader))
  (when (and exclude (not (equal exclude ""))) (setq org-agenda-entry-text-exclude-regexps (list exclude)))
  (org-agenda-list)
  (org-agenda-entry-text-mode)
  (with-current-buffer org-agenda-buffer-name
    (goto-char (point-min))
    (while (not (eobp))
      (let* ((line (buffer-substring-no-properties (line-beginning-position) (line-end-position)))
             (after (seq-some (lambda (o) (overlay-get o 'after-string))
                              (overlays-in (line-beginning-position) (line-end-position)))))
        (princ (json-encode (list line (or after :null))))
        (terpri))
      (forward-line 1))))
