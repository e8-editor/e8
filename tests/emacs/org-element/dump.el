;;; dump.el --- Record Org's parse trees for E8's parser to match  -*- lexical-binding: t -*-

;; Run from the repository's root:
;;
;;   emacs -Q --batch -l tests/emacs/org-element/dump.el
;;
;; Reads tests/emacs/org-element/cases.json, a list of {"name", "text"},
;; parses each text in an Org mode buffer with `org-element-parse-buffer'
;; and writes the trees to tests/emacs/org-element/golden.json, as
;; crates/e8-script/tests/all/org_element_parse.rs reads them: a node as
;; {"type", "props", "contents"}, plain text as a string, positions
;; counted from 0, symbols as their names and t as true; nil properties
;; are left out.

(require 'org)
(require 'org-element)
(require 'json)

(defconst e8-dump--dir
  (file-name-directory (or load-file-name buffer-file-name)))

(defconst e8-dump--skipped
  '(:parent :buffer :mode :granularity :cached :org-element--cache-sync-key
    :robust-begin :robust-end :secondary :deferred)
  "Properties that are the parser's own bookkeeping, not the tree's.")

(defconst e8-dump--positions
  '(:begin :end :contents-begin :contents-end :post-affiliated)
  "Properties that hold buffer positions, counted from 1 in Emacs.")

(defvar e8-dump--secondary
  '(:title :tag :prefix :suffix)
  "Properties holding secondary strings.")

(defun e8-dump--value (prop v)
  "V, the value of PROP, as JSON."
  (cond
   ((memq prop e8-dump--positions) (and v (1- v)))
   ;; Flags Org sets to where a switch matched, which E8 keeps as true.
   ((memq prop '(:preserve-indent :retain-labels :use-labels)) (and v t))
   ((eq prop :structure)
    (vconcat (mapcar (lambda (item)
                       (vector (1- (nth 0 item)) (nth 1 item) (nth 2 item)
                               (nth 3 item) (nth 4 item) (nth 5 item)
                               (1- (nth 6 item))))
                     v)))
   ((eq prop :caption)
    (vconcat (mapcar (lambda (entry)
                       (if (and (consp entry) (consp (car entry))
                                (not (symbolp (car (car entry)))))
                           ;; Org gives (MAIN . DUAL) for a caption with a short form.
                           `((value . ,(e8-dump--data (car entry)))
                             (secondary . ,(and (cdr entry) (e8-dump--data (cdr entry)))))
                         `((value . ,(e8-dump--data entry)) (secondary . nil))))
                     v)))
   ((eq prop :results)
    (if (consp v)
        `((value . ,(car v)) (secondary . ,(cdr v)))
      `((value . ,v) (secondary . nil))))
   ((memq prop e8-dump--secondary) (and v (e8-dump--data v)))
   ((memq prop '(:scheduled :deadline :closed :value))
    (if (and (consp v) (symbolp (car v))) (e8-dump--node v) (e8-dump--plain v)))
   (t (e8-dump--plain v))))

(defun e8-dump--plain (v)
  (cond
   ((eq v t) t)
   ((null v) nil)
   ((stringp v) (substring-no-properties v))
   ((numberp v) v)
   ((symbolp v) (symbol-name v))
   ((and (consp v) (not (listp (cdr v))))
    (vector (e8-dump--plain (car v)) (e8-dump--plain (cdr v))))
   ((listp v) (vconcat (mapcar #'e8-dump--plain v)))
   (t (format "%S" v))))

(defun e8-dump--data (data)
  "A secondary string or contents as a JSON array."
  (vconcat (mapcar #'e8-dump--datum data)))

(defun e8-dump--datum (d)
  (if (stringp d) (substring-no-properties d) (e8-dump--node d)))

(defun e8-dump--node (node)
  (let ((props nil))
    (org-element-properties-mapc
     (lambda (prop value _)
       ;; Nil properties are left out, as E8 leaves out undefined ones.
       (unless (or (memq prop e8-dump--skipped) (null value)
                   ;; The document's file, which a temporary buffer has none of.
                   (and (eq prop :path) (eq (org-element-type node) 'org-data)))
         (push (cons (substring (symbol-name prop) 1)
                     (e8-dump--value prop value))
               props)))
     node t)
    `((type . ,(symbol-name (org-element-type node)))
      (props . ,(or (sort props (lambda (a b) (string< (car a) (car b))))
                    (make-hash-table)))
      (contents . ,(e8-dump--data (org-element-contents node))))))

(let* ((json-object-type 'alist)
       (json-array-type 'list)
       (json-key-type 'string)
       (coding-system-for-read 'utf-8)
       (cases (json-read-file (expand-file-name "cases.json" e8-dump--dir)))
       (out nil))
  (dolist (case cases)
    ;; The libraries a case loads first, as org-inlinetask, unloaded after it.
    (let ((features (mapcar #'intern (alist-get "require" case nil nil #'equal))))
      (mapc #'require features)
      (unwind-protect
          (with-temp-buffer
            (insert (alist-get "text" case nil nil #'equal))
            (org-mode)
            (push `((name . ,(alist-get "name" case nil nil #'equal))
                    (tree . ,(e8-dump--node (org-element-parse-buffer)))
                    (interpreted . ,(org-element-interpret-data (org-element-parse-buffer))))
                  out))
        (dolist (f (reverse features))
          (when (featurep f) (unload-feature f t))))))
  (let ((coding-system-for-write 'utf-8)
        (json-encoding-pretty-print nil))
    (with-temp-file (expand-file-name "golden.json" e8-dump--dir)
      (insert (json-encode `((emacs_version . ,emacs-version)
                             (org_version . ,(org-version))
                             (cases . ,(vconcat (nreverse out))))))
      (insert "\n")))
  (message "org-element: %d cases" (length cases)))

;;; dump.el ends here
