// Org's HTML export backend, after ox-html.el: an Org document as an
// XHTML or HTML5 page, its headings as nested sections, with a table of
// contents, footnotes, tables, images and MathJax for LaTeX.
//
// Source blocks are coloured by htmlize.ts in their language's mode, as
// org-html-htmlize-output-type says. LaTeX as images (dvipng and its kin)
// and the info.js viewer are left out for now.

import { ALL_ELEMENTS, ALL_OBJECTS, type Datum, type Node, ancestor, contents as contentsOf, map, mapFirst, property, typeOf } from "org-element-ast";
import { interpretData, normalizeString } from "org-element";
import { EXPORT_PARAMS } from "org-loaddefs";
import { browseUrl } from "browse-url";
import { htmlizeRegion } from "htmlize";
import { langMode } from "org-src";
import { eraseBuffer } from "subr";
import { fileRelativeName as publishFileRelativeName, plistGet, publishOrgTo, resolveExternalLink as publishResolveExternalLink } from "ox-publish";
import {
  type Backend,
  type Info,
  activateSmartQuotes,
  collectFootnoteDefinitions,
  collectHeadlines,
  collectListings,
  collectTables,
  customProtocolMaybe,
  data,
  dataWithBackend,
  defineBackend,
  exportAs,
  fileUri,
  firstSiblingP,
  flag,
  footnoteFirstReferenceP,
  formatCode,
  getAltTitle,
  getCaption,
  getCoderefFormat,
  getDate,
  getFootnoteNumber,
  getHeadlineNumber,
  getLoc,
  getNextElements,
  getOrdinal,
  getPreviousElement,
  getReference,
  getRelativeLevel,
  getTags,
  inlineImageP,
  insertImageLinks,
  lastSiblingP,
  lowLevelP,
  mapOpts,
  nonNil,
  numberedHeadlineP,
  outputFileName,
  readAttribute,
  removeIndentation,
  resolveCoderef,
  resolveFuzzyLink,
  resolveIdLink,
  resolveLink,
  resolveRadioLink,
  snippetBackend,
  stringAs,
  tableCellAddress,
  tableCellAlignment,
  tableCellEndsColgroupP,
  tableCellStartsColgroupP,
  tableHasHeaderP,
  tableHasSpecialColumnP,
  tableRowEndsRowgroupP,
  tableRowGroup,
  tableRowNumber,
  tableRowStartsRowgroupP,
  toBuffer,
  toFile,
  tocEntryBackend,
  translate,
  unravelCode,
  varValue,
} from "ox";

const S = (name: string) => e8.intern(name);
const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });

// --- Variables, with Org 9.7's defaults ---------------------------------------

export const HTML_ID_ATTR_PREFIX = "ID-";
export const HTML_PRE_POSTAMBLE_CLASS = "status";
export const HTML_CHECKBOX_TYPES = [["unicode", ["on", "&#x2611;"], ["off", "&#x2610;"], ["trans", "&#x2610;"]], ["ascii", ["on", "<code>[X]</code>"], ["off", "<code>[&#xa0;]</code>"], ["trans", "<code>[-]</code>"]], ["html", ["on", "<input type='checkbox' checked='checked' />"], ["off", "<input type='checkbox' />"], ["trans", "<input type='checkbox' />"]]];
export const HTML_DOCTYPE_ALIST = [["html4-strict", "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\"\n\"http://www.w3.org/TR/html4/strict.dtd\">"], ["html4-transitional", "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01 Transitional//EN\"\n\"http://www.w3.org/TR/html4/loose.dtd\">"], ["html4-frameset", "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01 Frameset//EN\"\n\"http://www.w3.org/TR/html4/frameset.dtd\">"], ["xhtml-strict", "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\"\n\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">"], ["xhtml-transitional", "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\"\n\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd\">"], ["xhtml-frameset", "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Frameset//EN\"\n\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-frameset.dtd\">"], ["xhtml-11", "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.1//EN\"\n\"http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd\">"], ["html5", "<!DOCTYPE html>"], ["xhtml5", "<!DOCTYPE html>"]];
export const HTML_HTML5_ELEMENTS = ["article", "aside", "audio", "canvas", "details", "figcaption", "figure", "footer", "header", "menu", "meter", "nav", "output", "progress", "section", "summary", "video"];
export const HTML_INFOJS_OPTS_TABLE = [["path", "PATH", "https://orgmode.org/org-info.js"], ["view", "VIEW", "info"], ["toc", "TOC", ":with-toc"], ["ftoc", "FIXED_TOC", "0"], ["tdepth", "TOC_DEPTH", "max"], ["sdepth", "SECTION_DEPTH", "max"], ["mouse", "MOUSE_HINT", "underline"], ["buttons", "VIEW_BUTTONS", "0"], ["ltoc", "LOCAL_TOC", "1"], ["up", "LINK_UP", ":html-link-up"], ["home", "LINK_HOME", ":html-link-home"]];
export const HTML_SPECIAL_STRING_REGEXPS = [["\\\\-", "&#x00ad;"], ["---\\([^-]\\)", "&#x2014;\\1"], ["--\\([^-]\\)", "&#x2013;\\1"], ["\\.\\.\\.", "&#x2026;"]];
defvar("org-html-allow-name-attribute-in-anchors", false, "When nil, do not set \"name\" attribute in anchors.");
defvar("org-html-checkbox-type", S("ascii"), "The type of checkboxes to use for HTML export.");
defvar("org-html-coding-system", S("utf-8"), "Coding system for HTML export.");
defvar("org-html-container-element", "div", "HTML element to use for wrapping top level sections.");
defvar("org-html-content-class", "content", "CSS class name to use for the top level content wrapper.");
defvar("org-html-creator-string", `<a href="https://github.com/e8-editor/e8">E8</a> (<a href="https://orgmode.org">Org</a> mode)`, "Information about the creator of the HTML document.");
defvar("org-html-divs", [[S("preamble"), "div", "preamble"], [S("content"), "div", "content"], [S("postamble"), "div", "postamble"]], "Alist of the three section elements for HTML export.");
defvar("org-html-doctype", "xhtml-strict", "Document type definition to use for exported HTML files.");
defvar("org-html-equation-reference-format", "\\eqref{%s}", "The MathJax command to use when referencing equations.");
defvar("org-html-extension", "html", "The extension for exported HTML files.");
defvar("org-html-footnote-format", "<sup>%s</sup>", "The format for the footnote reference.");
defvar("org-html-footnote-separator", "<sup>, </sup>", "Text used to separate footnotes.");
defvar("org-html-footnotes-section", "<div id=\"footnotes\">\n<h2 class=\"footnotes\">%s: </h2>\n<div id=\"text-footnotes\">\n%s\n</div>\n</div>", "Format for the footnotes section.");
defvar("org-html-format-drawer-function", S("org-html-format-drawer-default-function"), "Function called to format a drawer in HTML code.");
defvar("org-html-format-headline-function", S("org-html-format-headline-default-function"), "Function to format headline text.");
defvar("org-html-format-inlinetask-function", S("org-html-format-inlinetask-default-function"), "Function called to format an inlinetask in HTML code.");
defvar("org-html-head", "", "Org-wide head definitions for exported HTML files.");
defvar("org-html-head-extra", "", "More head information to add in the HTML output.");
defvar("org-html-head-include-default-style", true, "Non-nil means include the default style in exported HTML files.");
defvar("org-html-head-include-scripts", false, "Non-nil means include the JavaScript snippets in exported HTML files.");
defvar("org-html-home/up-format", "<div id=\"org-div-home-and-up\">\n <a accesskey=\"h\" href=\"%s\"> UP </a>\n |\n <a accesskey=\"H\" href=\"%s\"> HOME </a>\n</div>", "Snippet used to insert the HOME and UP links.");
defvar("org-html-html5-fancy", false, "Non-nil means using new HTML5 elements.");
defvar("org-html-htmlize-font-prefix", "org-", "The prefix for CSS class names for htmlize font specifications.");
defvar("org-html-htmlize-output-type", S("inline-css"), "Output type to be used by htmlize when formatting code snippets.");
defvar("org-html-indent", false, "Non-nil means to indent the generated HTML.");
defvar("org-html-infojs-options", [[S("path"), "https://orgmode.org/org-info.js"], [S("view"), "info"], [S("toc"), S(":with-toc")], [S("ftoc"), "0"], [S("tdepth"), "max"], [S("sdepth"), "max"], [S("mouse"), "underline"], [S("buttons"), "0"], [S("ltoc"), "1"], [S("up"), S(":html-link-up")], [S("home"), S(":html-link-home")]], "Options settings for the INFOJS JavaScript.");
defvar("org-html-infojs-template", "<script src=\"%SCRIPT_PATH\">\n// @license magnet:?xt=urn:btih:1f739d935676111cfff4b4693e3816e664797050&amp;dn=gpl-3.0.txt GPL-v3-or-Later\n// @license-end\n</script>\n\n<script>\n// @license magnet:?xt=urn:btih:1f739d935676111cfff4b4693e3816e664797050&amp;dn=gpl-3.0.txt GPL-v3-or-Later\n%MANAGER_OPTIONS\norg_html_manager.setup();  // activate after the parameters are set\n// @license-end\n</script>", "The template for the export style additions when org-info.js is used.");
defvar("org-html-inline-image-rules", [["file", "\\(?:\\.\\(?:avif\\|gif\\|jp\\(?:e?g\\)\\|png\\|svg\\|webp\\)\\)"], ["http", "\\(?:\\.\\(?:avif\\|gif\\|jp\\(?:e?g\\)\\|png\\|svg\\|webp\\)\\)"], ["https", "\\(?:\\.\\(?:avif\\|gif\\|jp\\(?:e?g\\)\\|png\\|svg\\|webp\\)\\)"]], "Rules characterizing image files that can be inlined into HTML.");
defvar("org-html-inline-images", true, "Non-nil means inline images into exported HTML pages.");
defvar("org-html-klipse-css", "https://storage.googleapis.com/app.klipse.tech/css/codemirror.css", "Location of the codemirror CSS file for use with klipse.");
defvar("org-html-klipse-js", "https://storage.googleapis.com/app.klipse.tech/plugin_prod/js/klipse_plugin.min.js", "Location of the klipse javascript file.");
defvar("org-html-klipse-selection-script", "window.klipse_settings = {selector_eval_html: '.src-html',\n                             selector_eval_js: '.src-js',\n                             selector_eval_python_client: '.src-python',\n                             selector_eval_scheme: '.src-scheme',\n                             selector: '.src-clojure',\n                             selector_eval_ruby: '.src-ruby'};", "Javascript snippet to activate klipse.");
defvar("org-html-klipsify-src", false, "When non-nil, source code blocks are editable in exported presentation.");
defvar("org-html-link-home", "", "Where should the \"HOME\" link of exported HTML pages lead?");
defvar("org-html-link-org-files-as-html", true, "Non-nil means make file links to \"file.org\" point to \"file.html\".");
defvar("org-html-link-up", "", "Where should the \"UP\" link of exported HTML pages lead?");
defvar("org-html-link-use-abs-url", false, "Should we prepend relative links with HTML_LINK_HOME?");
defvar("org-html-mathjax-options", [[S("path"), "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"], [S("scale"), 1.0], [S("align"), "center"], [S("font"), "mathjax-modern"], [S("overflow"), "overflow"], [S("tags"), "ams"], [S("indent"), "0em"], [S("multlinewidth"), "85%"], [S("tagindent"), ".8em"], [S("tagside"), "right"]], "Options for MathJax setup.");
defvar("org-html-mathjax-template", "<script>\n  window.MathJax = {\n    tex: {\n      ams: {\n        multlineWidth: '%MULTLINEWIDTH'\n      },\n      tags: '%TAGS',\n      tagSide: '%TAGSIDE',\n      tagIndent: '%TAGINDENT'\n    },\n    chtml: {\n      scale: %SCALE,\n      displayAlign: '%ALIGN',\n      displayIndent: '%INDENT'\n    },\n    svg: {\n      scale: %SCALE,\n      displayAlign: '%ALIGN',\n      displayIndent: '%INDENT'\n    },\n    output: {\n      font: '%FONT',\n      displayOverflow: '%OVERFLOW'\n    }\n  };\n</script>\n\n<script\n  id=\"MathJax-script\"\n  async\n  src=\"%PATH\">\n</script>", "The MathJax template.  See also `org-html-mathjax-options'.");
defvar("org-html-meta-tags", S("org-html-meta-tags-default"), "Form that is used to produce meta tags in the HTML head.");
defvar("org-html-metadata-timestamp-format", "%Y-%m-%d %a %H:%M", "Format used for timestamps in preamble, postamble and metadata.");
defvar("org-html-postamble", S("auto"), "Non-nil means insert a postamble in HTML export.");
defvar("org-html-postamble-format", [["en", "<p class=\"author\">Author: %a (%e)</p>\n<p class=\"date\">Date: %d</p>\n<p class=\"creator\">%c</p>\n<p class=\"validation\">%v</p>"]], "Alist of languages and format strings for the HTML postamble.");
defvar("org-html-preamble", true, "Non-nil means insert a preamble in HTML export.");
defvar("org-html-preamble-format", [["en", ""]], "Alist of languages and format strings for the HTML preamble.");
defvar("org-html-prefer-user-labels", false, "When non-nil use user-defined names and ID over internal ones.");
defvar("org-html-protect-char-alist", [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"]], "");
defvar("org-html-scripts", "<script>\n// @license magnet:?xt=urn:btih:1f739d935676111cfff4b4693e3816e664797050&amp;dn=gpl-3.0.txt GPL-v3-or-Later\n     function CodeHighlightOn(elem, id)\n     {\n       var target = document.getElementById(id);\n       if(null != target) {\n         elem.classList.add(\"code-highlighted\");\n         target.classList.add(\"code-highlighted\");\n       }\n     }\n     function CodeHighlightOff(elem, id)\n     {\n       var target = document.getElementById(id);\n       if(null != target) {\n         elem.classList.remove(\"code-highlighted\");\n         target.classList.remove(\"code-highlighted\");\n       }\n     }\n// @license-end\n</script>", "Basic JavaScript to allow highlighting references in code blocks.");
defvar("org-html-self-link-headlines", false, "When non-nil, the headlines contain a hyperlink to themselves.");
defvar("org-html-style-default", "<style type=\"text/css\">\n  #content { max-width: 60em; margin: auto; }\n  .title  { text-align: center;\n             margin-bottom: .2em; }\n  .subtitle { text-align: center;\n              font-size: medium;\n              font-weight: bold;\n              margin-top:0; }\n  .todo   { font-family: monospace; color: red; }\n  .done   { font-family: monospace; color: green; }\n  .priority { font-family: monospace; color: orange; }\n  .tag    { background-color: #eee; font-family: monospace;\n            padding: 2px; font-size: 80%; font-weight: normal; }\n  .timestamp { color: #bebebe; }\n  .timestamp-kwd { color: #5f9ea0; }\n  .org-right  { margin-left: auto; margin-right: 0px;  text-align: right; }\n  .org-left   { margin-left: 0px;  margin-right: auto; text-align: left; }\n  .org-center { margin-left: auto; margin-right: auto; text-align: center; }\n  .underline { text-decoration: underline; }\n  #postamble p, #preamble p { font-size: 90%; margin: .2em; }\n  p.verse { margin-left: 3%; }\n  pre {\n    border: 1px solid #e6e6e6;\n    border-radius: 3px;\n    background-color: #f2f2f2;\n    padding: 8pt;\n    font-family: monospace;\n    overflow: auto;\n    margin: 1.2em;\n  }\n  pre.src {\n    position: relative;\n    overflow: auto;\n  }\n  pre.src:before {\n    display: none;\n    position: absolute;\n    top: -8px;\n    right: 12px;\n    padding: 3px;\n    color: #555;\n    background-color: #f2f2f299;\n  }\n  pre.src:hover:before { display: inline; margin-top: 14px;}\n  /* Languages per Org manual */\n  pre.src-asymptote:before { content: 'Asymptote'; }\n  pre.src-awk:before { content: 'Awk'; }\n  pre.src-authinfo::before { content: 'Authinfo'; }\n  pre.src-C:before { content: 'C'; }\n  /* pre.src-C++ doesn't work in CSS */\n  pre.src-clojure:before { content: 'Clojure'; }\n  pre.src-css:before { content: 'CSS'; }\n  pre.src-D:before { content: 'D'; }\n  pre.src-ditaa:before { content: 'ditaa'; }\n  pre.src-dot:before { content: 'Graphviz'; }\n  pre.src-calc:before { content: 'Emacs Calc'; }\n  pre.src-emacs-lisp:before { content: 'Emacs Lisp'; }\n  pre.src-fortran:before { content: 'Fortran'; }\n  pre.src-gnuplot:before { content: 'gnuplot'; }\n  pre.src-haskell:before { content: 'Haskell'; }\n  pre.src-hledger:before { content: 'hledger'; }\n  pre.src-java:before { content: 'Java'; }\n  pre.src-js:before { content: 'Javascript'; }\n  pre.src-latex:before { content: 'LaTeX'; }\n  pre.src-ledger:before { content: 'Ledger'; }\n  pre.src-lisp:before { content: 'Lisp'; }\n  pre.src-lilypond:before { content: 'Lilypond'; }\n  pre.src-lua:before { content: 'Lua'; }\n  pre.src-matlab:before { content: 'MATLAB'; }\n  pre.src-mscgen:before { content: 'Mscgen'; }\n  pre.src-ocaml:before { content: 'Objective Caml'; }\n  pre.src-octave:before { content: 'Octave'; }\n  pre.src-org:before { content: 'Org mode'; }\n  pre.src-oz:before { content: 'OZ'; }\n  pre.src-plantuml:before { content: 'Plantuml'; }\n  pre.src-processing:before { content: 'Processing.js'; }\n  pre.src-python:before { content: 'Python'; }\n  pre.src-R:before { content: 'R'; }\n  pre.src-ruby:before { content: 'Ruby'; }\n  pre.src-sass:before { content: 'Sass'; }\n  pre.src-scheme:before { content: 'Scheme'; }\n  pre.src-screen:before { content: 'Gnu Screen'; }\n  pre.src-sed:before { content: 'Sed'; }\n  pre.src-sh:before { content: 'shell'; }\n  pre.src-sql:before { content: 'SQL'; }\n  pre.src-sqlite:before { content: 'SQLite'; }\n  /* additional languages in org.el's org-babel-load-languages alist */\n  pre.src-forth:before { content: 'Forth'; }\n  pre.src-io:before { content: 'IO'; }\n  pre.src-J:before { content: 'J'; }\n  pre.src-makefile:before { content: 'Makefile'; }\n  pre.src-maxima:before { content: 'Maxima'; }\n  pre.src-perl:before { content: 'Perl'; }\n  pre.src-picolisp:before { content: 'Pico Lisp'; }\n  pre.src-scala:before { content: 'Scala'; }\n  pre.src-shell:before { content: 'Shell Script'; }\n  pre.src-ebnf2ps:before { content: 'ebfn2ps'; }\n  /* additional language identifiers per \"defun org-babel-execute\"\n       in ob-*.el */\n  pre.src-cpp:before  { content: 'C++'; }\n  pre.src-abc:before  { content: 'ABC'; }\n  pre.src-coq:before  { content: 'Coq'; }\n  pre.src-groovy:before  { content: 'Groovy'; }\n  /* additional language identifiers from org-babel-shell-names in\n     ob-shell.el: ob-shell is the only babel language using a lambda to put\n     the execution function name together. */\n  pre.src-bash:before  { content: 'bash'; }\n  pre.src-csh:before  { content: 'csh'; }\n  pre.src-ash:before  { content: 'ash'; }\n  pre.src-dash:before  { content: 'dash'; }\n  pre.src-ksh:before  { content: 'ksh'; }\n  pre.src-mksh:before  { content: 'mksh'; }\n  pre.src-posh:before  { content: 'posh'; }\n  /* Additional Emacs modes also supported by the LaTeX listings package */\n  pre.src-ada:before { content: 'Ada'; }\n  pre.src-asm:before { content: 'Assembler'; }\n  pre.src-caml:before { content: 'Caml'; }\n  pre.src-delphi:before { content: 'Delphi'; }\n  pre.src-html:before { content: 'HTML'; }\n  pre.src-idl:before { content: 'IDL'; }\n  pre.src-mercury:before { content: 'Mercury'; }\n  pre.src-metapost:before { content: 'MetaPost'; }\n  pre.src-modula-2:before { content: 'Modula-2'; }\n  pre.src-pascal:before { content: 'Pascal'; }\n  pre.src-ps:before { content: 'PostScript'; }\n  pre.src-prolog:before { content: 'Prolog'; }\n  pre.src-simula:before { content: 'Simula'; }\n  pre.src-tcl:before { content: 'tcl'; }\n  pre.src-tex:before { content: 'TeX'; }\n  pre.src-plain-tex:before { content: 'Plain TeX'; }\n  pre.src-verilog:before { content: 'Verilog'; }\n  pre.src-vhdl:before { content: 'VHDL'; }\n  pre.src-xml:before { content: 'XML'; }\n  pre.src-nxml:before { content: 'XML'; }\n  /* add a generic configuration mode; LaTeX export needs an additional\n     (add-to-list 'org-latex-listings-langs '(conf \" \")) in .emacs */\n  pre.src-conf:before { content: 'Configuration File'; }\n\n  table { border-collapse:collapse; }\n  caption.t-above { caption-side: top; }\n  caption.t-bottom { caption-side: bottom; }\n  td, th { vertical-align:top;  }\n  th.org-right  { text-align: center;  }\n  th.org-left   { text-align: center;   }\n  th.org-center { text-align: center; }\n  td.org-right  { text-align: right;  }\n  td.org-left   { text-align: left;   }\n  td.org-center { text-align: center; }\n  dt { font-weight: bold; }\n  .footpara { display: inline; }\n  .footdef  { margin-bottom: 1em; }\n  .figure { padding: 1em; }\n  .figure p { text-align: center; }\n  .equation-container {\n    display: table;\n    text-align: center;\n    width: 100%;\n  }\n  .equation {\n    vertical-align: middle;\n  }\n  .equation-label {\n    display: table-cell;\n    text-align: right;\n    vertical-align: middle;\n  }\n  .inlinetask {\n    padding: 10px;\n    border: 2px solid gray;\n    margin: 10px;\n    background: #ffffcc;\n  }\n  #org-div-home-and-up\n   { text-align: right; font-size: 70%; white-space: nowrap; }\n  textarea { overflow-x: auto; }\n  .linenr { font-size: smaller }\n  .code-highlighted { background-color: #ffff00; }\n  .org-info-js_info-navigation { border-style: none; }\n  #org-info-js_console-label\n    { font-size: 10px; font-weight: bold; white-space: nowrap; }\n  .org-info-js_search-highlight\n    { background-color: #ffff00; color: #000000; font-weight: bold; }\n  .org-svg { }\n</style>", "The default style specification for exported HTML files.");
defvar("org-html-table-align-individual-fields", true, "Non-nil means attach style attributes for alignment to each table field.");
defvar("org-html-table-caption-above", true, "When non-nil, place caption string at the beginning of the table.");
defvar("org-html-table-data-tags", ["<td%s>", "</td>"], "The opening and ending tags for table data fields.");
defvar("org-html-table-default-attributes", [S(":border"), "2", S(":cellspacing"), "0", S(":cellpadding"), "6", S(":rules"), "groups", S(":frame"), "hsides"], "Default attributes and values which will be used in table tags.");
defvar("org-html-table-header-tags", ["<th scope=\"%s\"%s>", "</th>"], "The opening and ending tags for table header fields.");
defvar("org-html-table-row-close-tag", "</tr>", "The closing tag for table rows.");
defvar("org-html-table-row-open-tag", "<tr>", "The opening tag for table rows.");
defvar("org-html-table-use-header-tags-for-first-column", false, "Non-nil means format column one in tables with header tags.");
defvar("org-html-tag-class-prefix", "", "Prefix to class names for TODO keywords.");
defvar("org-html-text-markup-alist", [[S("bold"), "<b>%s</b>"], [S("code"), "<code>%s</code>"], [S("italic"), "<i>%s</i>"], [S("strike-through"), "<del>%s</del>"], [S("underline"), "<span class=\"underline\">%s</span>"], [S("verbatim"), "<code>%s</code>"]], "Alist of HTML expressions to convert text markup.");
defvar("org-html-todo-kwd-class-prefix", "", "Prefix to class names for TODO keywords.");
defvar("org-html-toplevel-hlevel", 2, "The <H> level for level 1 headings in HTML export.");
defvar("org-html-use-infojs", S("when-configured"), "Non-nil when Sebastian Rose's Java Script org-info.js should be active.");
defvar("org-html-validation-link", "<a href=\"https://validator.w3.org/check?uri=referer\">Validate</a>", "Link to HTML validation service.");
defvar("org-html-viewport", [[S("width"), "device-width"], [S("initial-scale"), "1"], [S("minimum-scale"), ""], [S("maximum-scale"), ""], [S("user-scalable"), ""]], "Viewport options for mobile-optimized sites.");
defvar("org-html-with-latex", true, "Non-nil means process LaTeX math snippets.");
defvar("org-html-wrap-src-lines", false, "If non-nil, wrap individual lines of source blocks in \"code\" elements.");
defvar("org-html-xml-declaration", [["html", "<?xml version=\"1.0\" encoding=\"%s\"?>"], ["php", "<?php echo \"<?xml version=\\\"1.0\\\" encoding=\\\"%s\\\" ?>\"; ?>"]], "The extension for exported HTML files.");

defvar("org-html-protect-char-alist", [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"]], "Alist of characters to be converted by `org-html-encode-plain-text'.");

// --- Helpers ---------------------------------------------------------------------

/** Whether a string has any non-blank character, as org-string-nw-p. */
const nw = (s: unknown): s is string => typeof s === "string" && /\S/.test(s);

/** A string as Lisp's format writes it with %s and %d: nil as "nil". */
const str = (v: unknown): string => (v === undefined || v === null || v === false ? "nil" : v === true ? "t" : String(v));

/** Format with %s, %d and %c, as Lisp's format, for the templates users set. */
export function format(template: string, ...args: unknown[]): string {
  let i = 0;
  return template.replace(/%(-?\d*)([sdc%])/g, (_m, width: string, c: string) => {
    if (c === "%") return "%";
    const v = args[i++];
    const s = c === "c" ? String.fromCodePoint(Number(v)) : c === "d" ? String(Math.trunc(Number(v))) : str(v);
    const w = parseInt(width || "0", 10);
    return w < 0 ? s.padEnd(-w) : s.padStart(w);
  });
}

/** A string spec filled, as format-spec: %x by the spec's value for x, %% a percent. */
function formatSpec(template: string, spec: { [k: string]: string }): string {
  return template.replace(/%(.)/g, (m, c: string) => (c === "%" ? "%" : c in spec ? spec[c] : m));
}

/** Assoc in a list of [key, ...] entries. */
const assoc = (list: any, key: string): any[] | undefined => (Array.isArray(list) ? list.find((e: any) => Array.isArray(e) && e[0] === key) : undefined);

/** Call a function a variable holds: E8's own default directly, else what it names or is. */
function callFunction(fn: any, defaults: { [name: string]: (...args: any[]) => any }, ...args: any[]): any {
  if (typeof fn === "function") return fn(...args);
  const name = typeof fn === "symbol" ? e8.symbolName(fn) : String(fn);
  if (defaults[name]) return defaults[name](...args);
  return e8.funcall(name, ...args);
}

/** The text with blank lines around it removed, as org-trim. */
const trim = (s: string) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");

export function xhtmlP(info: Info): boolean {
  return String(info["html-doctype"]).toLowerCase().includes("xhtml");
}

export function html5P(info: Info): boolean {
  return ["html5", "xhtml5", "<!doctype html>"].includes(String(info["html-doctype"]).toLowerCase());
}

function html5FancyP(info: Info): boolean {
  return nonNil(info["html-html5-fancy"]) && html5P(info);
}

/** A tag closed as the doctype wants, as org-html-close-tag: <br /> in XHTML. */
export function closeTag(tag: string, attr: string | undefined, info: Info): string {
  const a = " " + (attr ?? "");
  return "<" + tag + (nw(a) ? a : "") + (xhtmlP(info) ? " />" : ">");
}

export function doctype(info: Info): string {
  const dt = info["html-doctype"];
  return assoc(HTML_DOCTYPE_ALIST, dt)?.[1] ?? dt;
}

/** A property list's attributes written out, as org-html--make-attribute-string: :key "value" as key="value", nil values left out. */
export function makeAttributeString(attributes: { [key: string]: any } | any[] | undefined): string {
  const out: string[] = [];
  const entries: [string, any][] = [];
  if (Array.isArray(attributes)) for (let i = 0; i + 1 < attributes.length; i += 2) entries.push([String(attributes[i]), attributes[i + 1]]);
  else if (attributes) entries.push(...Object.entries(attributes));
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === false) continue;
    out.push(`${key.replace(/^:/, "")}="${encodePlainText(String(value)).replace(/"/g, "&quot;")}"`);
  }
  return out.join(" ");
}

/** A datum's id: its user label when there is one and labels are preferred, or a CUSTOM_ID, else a reference, as org-html--reference. */
export function reference(datum: Datum, info: Info, namedOnly = false): string | undefined {
  const type = typeOf(datum)!;
  const customId = type === "headline" || type === "inlinetask" ? property("CUSTOM_ID", datum) : undefined;
  const id = property("ID", datum);
  const userLabel =
    customId ??
    (type === "radio-target" || type === "target" ? property("value", datum) : undefined) ??
    property("name", datum) ??
    (id ? HTML_ID_ATTR_PREFIX + id : undefined);
  if (userLabel && (nonNil(info["html-prefer-user-labels"]) || customId)) return userLabel;
  if (namedOnly && !["headline", "inlinetask", "radio-target", "target"].includes(type) && !userLabel) return undefined;
  return getReference(datum, info);
}

function wrapImage(contents: string, info: Info, caption?: string, label?: string): string {
  const fancy = html5FancyP(info);
  return format(
    fancy ? "\n<figure%s>\n%s%s\n</figure>" : "\n<div%s class=\"figure\">\n%s%s\n</div>",
    nw(label) ? ` id="${label}"` : "",
    fancy ? contents : `<p>${contents}</p>`,
    !nw(caption) ? "" : format(fancy ? "\n<figcaption>%s</figcaption>" : "\n<p>%s</p>", caption),
  );
}

function formatImage(source: string, attributes: { [k: string]: any } | undefined, info: Info): string {
  const latexDir = String(varValue("org-preview-latex-image-directory") || "ltximg/");
  let plist: { [k: string]: any } = { ":src": source, ":alt": source.startsWith(latexDir) ? encodePlainText(source) : e8.fileNameNondirectory(source) };
  if (/\.svg$/i.test(source) && source.split(".").pop() === "svg") plist = { ...plist, ":class": "org-svg", ...(attributes ?? {}), ":fallback": undefined };
  else plist = { ...plist, ...(attributes ?? {}) };
  return closeTag("img", makeAttributeString(plist), info);
}

function textareaBlock(element: Node): string {
  const code = unravelCode(element)[0];
  const attr = readAttribute("attr_html", element) ?? {};
  const lines = code === "" ? 0 : code.split("\n").length - (code.endsWith("\n") ? 1 : 0);
  return format('<p>\n<textarea cols="%s" rows="%s">\n%s</textarea>\n</p>', attr[":width"] ?? 80, attr[":height"] ?? lines, code);
}

const hasCaptionP = (element: Datum) => nonNil(property("caption", element));

export function fixClassName(kwd: string): string {
  return kwd.replace(/[^a-zA-Z0-9_]/g, "_");
}

function footnoteSection(info: Info): string | undefined {
  const definitions = collectFootnoteDefinitions(info);
  if (definitions.length === 0) return undefined;
  const items = definitions.map(([n, given, def]) => {
    const label = typeof given === "string" && given === String(parseInt(given, 10) || 0) ? undefined : given;
    const inline = typeof def === "string" || !mapFirst(def, ALL_ELEMENTS, (x) => x);
    const anchor = htmlAnchor(`fn.${label ?? n}`, String(n), ` class="footnum" href="#fnr.${label ?? n}" role="doc-backlink"`, info);
    const c = trim(data(def as any, info));
    return format(
      '<div class="footdef">%s %s</div>\n',
      format(info["html-footnote-format"], anchor),
      format('<div class="footpara" role="doc-footnote">%s</div>', !inline ? c : format('<p class="footpara">%s</p>', c)),
    );
  });
  return format(info["html-footnotes-section"], translateHtml("Footnotes", info), format("\n%s\n", items.join("\n")));
}

// --- Template --------------------------------------------------------------

/** The meta tags a page gets, as org-html-meta-tags-default: author, description, keywords and generator. */
export function metaTagsDefault(info: Info): (string[] | undefined)[] {
  const author = nonNil(info["with-author"]) && info["author"] ? interpretData(info["author"]) : undefined;
  return [
    nw(author) ? ["name", "author", author] : undefined,
    nw(info["description"]) ? ["name", "description", info["description"]] : undefined,
    nw(info["keywords"]) ? ["name", "keywords", info["keywords"]] : undefined,
    ["name", "generator", "Org Mode"],
  ];
}
e8.defun("org-html-meta-tags-default", (info: Info) => metaTagsDefault(info));

function buildMetaEntry(label: string, identity: string, content?: string, ...formatters: unknown[]): string {
  return (
    "<meta " +
    `${label}="${identity}` +
    (content !== undefined ? '" content="' + encodePlainText(formatters.length ? format(content, ...formatters) : content).replace(/"/g, "&quot;") : "") +
    '" />\n'
  );
}

/** The charset the page declares, from org-html-coding-system, as its mime-charset. */
function charset(): string {
  const cs = varValue("org-html-coding-system");
  if (!nonNil(cs)) return "iso-8859-1";
  return String(cs).replace(/-(unix|dos|mac)$/, "").replace(/^(prefer-)?utf-8.*/, "utf-8").toLowerCase();
}

function buildMetaInfo(info: Info): string {
  const t = plainText(interpretData(info["title"] ?? []), info);
  const title = nw(t) ? t : "&lrm;";
  let out = "";
  if (nonNil(info["time-stamp-file"])) out += e8.formatTimeString(`<!-- ${info["html-metadata-timestamp-format"]} -->\n`);
  out += html5P(info) ? buildMetaEntry("charset", charset()) : buildMetaEntry("http-equiv", "Content-Type", "text/html;charset=" + charset());
  const viewport = (Array.isArray(info["html-viewport"]) ? info["html-viewport"] : []).filter((cell: any) => nw(cell[1]));
  if (viewport.length) out += buildMetaEntry("name", "viewport", viewport.map((e: any) => `${e[0]}=${e[1]}`).join(", "));
  out += `<title>${title}</title>\n`;
  const tags = varValue("org-html-meta-tags");
  const list: any[] = Array.isArray(tags) ? tags : callFunction(e8.variable("org-html-meta-tags"), { "org-html-meta-tags-default": metaTagsDefault }, info);
  for (const args of list) if (args) out += buildMetaEntry(String(args[0]), String(args[1]), args[2] === undefined ? undefined : String(args[2]), ...args.slice(3));
  return out;
}

function buildHead(info: Info): string {
  return normalizeString(
    (nonNil(info["html-head-include-default-style"]) ? normalizeString(String(varValue("org-html-style-default"))) : "") +
      normalizeString(String(info["html-head"] || "")) +
      normalizeString(String(info["html-head-extra"] || "")) +
      (nonNil(info["html-htmlized-css-url"]) && varValue("org-html-htmlize-output-type") === "css"
        ? closeTag("link", format('rel="stylesheet" href="%s" type="text/css"', info["html-htmlized-css-url"]), info)
        : "") +
      (nonNil(info["html-head-include-scripts"]) ? String(varValue("org-html-scripts")) : ""),
  );
}

function buildMathjaxConfig(info: Info): string {
  const withLatex = info["with-latex"];
  if (!(withLatex === "mathjax" || withLatex === true)) return "";
  if (!mapFirst(info["parse-tree"], ["latex-fragment", "latex-environment"], (x) => x, mapOpts(info, { withAffiliated: true }))) return "";
  let template = String(info["html-mathjax-template"]);
  const given: any[] = Array.isArray(info["html-mathjax-options"]) ? info["html-mathjax-options"] : [];
  const has = (k: string) => given.some((e) => e[0] === k);
  const options: [string, any][] = [[has("autonumber") ? "tags" : "autonumber", undefined], [has("linebreaks") ? "overflow" : "linebreaks", undefined], ...given.map((e) => [e[0], e[1]] as [string, any])];
  const inBuffer = String(info["html-mathjax"] || "");
  for (let [symbol, value] of options) {
    const m = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).exec(inBuffer);
    if (m) value = inBuffer.slice(m.index + m[0].length).trim().split(/\s+/)[0];
    if (value === undefined || value === false) continue;
    if (symbol === "font") {
      const fonts: { [k: string]: string } = { TeX: "mathjax-tex", "STIX-Web": "mathjax-stix2", "Asana-Math": "mathjax-asana", "Neo-Euler": "mathjax-euler", "Gyre-Pagella": "mathjax-pagella", "Gyre-Termes": "mathjax-termes", "Latin-Modern": "mathjax-modern" };
      if (fonts[value]) value = fonts[value];
    } else if (symbol === "linebreaks") {
      symbol = "overflow";
      value = value === "true" ? "linebreak" : "overflow";
    } else if (symbol === "scale") {
      if (typeof value === "string") value = parseFloat(value) || 1.0;
      if (value >= 10) value = value / 100;
    } else if (symbol === "autonumber") {
      symbol = "tags";
      value = String(value).toLowerCase();
    }
    const shown = typeof value === "number" && Number.isInteger(value) && symbol === "scale" ? value.toFixed(1) : String(value);
    const re = new RegExp(`(%${symbol.toUpperCase()})(?=[^A-Z])`);
    while (re.test(template)) template = template.replace(re, shown);
  }
  return normalizeString(template);
}

/** The values a pre- or postamble's format string takes, as org-html-format-spec. */
function formatSpecOf(info: Info): { [k: string]: string } {
  const timestampFormat = info["html-metadata-timestamp-format"];
  const file = info["input-file"];
  const attrs = file ? e8.fileAttributes(file) : undefined;
  return {
    t: data(info["title"], info),
    s: data(info["subtitle"], info),
    d: data(getDate(info, timestampFormat), info),
    T: e8.formatTimeString(timestampFormat),
    a: data(info["author"], info),
    e: String(info["email"] || "")
      .split(/,+ */)
      .map((e) => `<a href="mailto:${e}">${e}</a>`)
      .join(", "),
    c: String(info["creator"] ?? ""),
    C: e8.formatTimeString(timestampFormat, attrs ? attrs.modified / 1000 : undefined),
    v: String(info["html-validation-link"] || ""),
  };
}

function buildPrePostamble(type: "preamble" | "postamble", info: Info): string {
  const section = info[`html-${type}`];
  if (!nonNil(section)) return "";
  const spec = formatSpecOf(info);
  let sectionContents: string;
  if (typeof section === "function") sectionContents = section(info);
  else if (section === "auto" && type === "postamble") {
    const { d: date, a: author, e: email, c: creator, v: validationLink } = spec;
    sectionContents =
      (nonNil(info["with-date"]) && nw(date) ? format('<p class="date">%s: %s</p>\n', translateHtml("Date", info), date) : "") +
      (nonNil(info["with-author"]) && nw(author) ? format('<p class="author">%s: %s</p>\n', translateHtml("Author", info), author) : "") +
      (nonNil(info["with-email"]) && nw(email) ? format('<p class="email">%s: %s</p>\n', translateHtml("Email", info), email) : "") +
      (nonNil(info["time-stamp-file"]) ? format('<p class="date">%s: %s</p>\n', translateHtml("Created", info), e8.formatTimeString(info["html-metadata-timestamp-format"])) : "") +
      (nonNil(info["with-creator"]) && nw(creator) ? format('<p class="creator">%s</p>\n', creator) : "") +
      (nw(validationLink) ? format('<p class="validation">%s</p>\n', validationLink) : "");
  } else if (typeof section === "string" && section !== "auto") sectionContents = formatSpec(section, spec);
  else {
    const formats: any[] = info[type === "preamble" ? "html-preamble-format" : "html-postamble-format"] ?? [];
    const language = String(info["language"]).toLowerCase();
    const entry = formats.find((f) => String(f[0]).toLowerCase() === language) ?? formats.find((f) => String(f[0]).toLowerCase() === "en");
    sectionContents = formatSpec(String(entry?.[1] ?? ""), spec);
  }
  const div = assoc(info["html-divs"], type);
  if (!nw(sectionContents)) return "";
  return format('<%s id="%s" class="%s">\n', div?.[1], div?.[2], HTML_PRE_POSTAMBLE_CLASS) + normalizeString(sectionContents) + format("</%s>\n", div?.[1]);
}

function innerTemplate(contents: string, info: Info): string {
  const depth = info["with-toc"];
  return (nonNil(depth) ? toc(depth, info) ?? "" : "") + contents + (footnoteSection(info) ?? "");
}

function template(contents: string, info: Info): string {
  let out = "";
  if (!html5P(info) && xhtmlP(info)) {
    const xml = info["html-xml-declaration"];
    const decl = (typeof xml === "string" ? xml : undefined) ?? assoc(xml, info["html-extension"])?.[1] ?? assoc(xml, "html")?.[1] ?? "";
    if (decl !== "") out += format("%s\n", format(decl, charset()));
  }
  out += doctype(info) + "\n";
  out +=
    "<html" +
    (xhtmlP(info) ? format(' xmlns="http://www.w3.org/1999/xhtml" lang="%s" xml:lang="%s"', info["language"], info["language"]) : html5P(info) ? format(' lang="%s"', info["language"]) : "") +
    ">\n";
  out += "<head>\n" + buildMetaInfo(info) + buildHead(info) + buildMathjaxConfig(info) + "</head>\n<body>\n";
  const linkUp = trim(String(info["html-link-up"] || ""));
  const linkHome = trim(String(info["html-link-home"] || ""));
  if (!(linkUp === "" && linkHome === "")) out += format(info["html-home/up-format"], linkUp || linkHome, linkHome || linkUp);
  out += buildPrePostamble("preamble", info);
  const div = assoc(info["html-divs"], "content");
  out += format('<%s id="%s" class="%s">\n', div?.[1], div?.[2], info["html-content-class"]);
  if (nonNil(info["with-title"])) {
    const title = info["title"];
    const subtitle = info["subtitle"];
    const fancy = html5FancyP(info);
    if (nonNil(title))
      out += format(
        fancy ? '<header>\n<h1 class="title">%s</h1>\n%s</header>' : '<h1 class="title">%s%s</h1>\n',
        data(title, info),
        nonNil(subtitle)
          ? format(fancy ? '<p class="subtitle" role="doc-subtitle">%s</p>\n' : "\n" + closeTag("br", undefined, info) + '\n<span class="subtitle">%s</span>\n', data(subtitle, info))
          : "",
      );
  }
  out += contents;
  out += format("</%s>\n", div?.[1]);
  out += buildPrePostamble("postamble", info);
  if (nonNil(info["html-klipsify-src"]))
    out +=
      "<script>" +
      info["html-klipse-selection-script"] +
      '</script><script src="' +
      varValue("org-html-klipse-js") +
      '"></script><link rel="stylesheet" type="text/css" href="' +
      varValue("org-html-klipse-css") +
      '"/>';
  return out + "</body>\n</html>";
}

export function translateHtml(s: string, info: Info): string {
  return translate(s, "html", info);
}

/** An anchor, as org-html--anchor. */
export function htmlAnchor(id: string | undefined, desc: string | undefined, attributes: string | undefined, info: Info): string {
  const name = nonNil(info["html-allow-name-attribute-in-anchors"]) ? id : undefined;
  const attrs = (id ? ` id="${id}"` : "") + (name ? ` name="${name}"` : "") + (attributes ?? "");
  return `<a${attrs}>${desc ?? ""}</a>`;
}

function todoHtml(todo: string | undefined, todoType: string | undefined, info: Info | undefined): string | undefined {
  if (!todo) return undefined;
  return format('<span class="%s %s%s">%s</span>', todoType === "done" ? "done" : "todo", info?.["html-todo-kwd-class-prefix"] || "", fixClassName(todo), todo);
}

function priorityHtml(priority: number | string | undefined): string | undefined {
  if (priority === undefined || priority === null) return undefined;
  return `<span class="priority">[${typeof priority === "number" ? String.fromCodePoint(priority) : priority}]</span>`;
}

function tagsHtml(tags: string[] | undefined, info: Info | undefined): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  return `<span class="tag">${tags.map((tag) => `<span class="${(info?.["html-tag-class-prefix"] || "") + fixClassName(tag)}">${tag}</span>`).join("&#xa0;")}</span>`;
}

// --- Source code ---------------------------------------------------------------

/**
 * The text from start to end as HTML, as org-html-htmlize-region-for-paste:
 * the <pre> htmlize makes, in org-html-htmlize-output-type, its classes
 * prefixed with org-html-htmlize-font-prefix. With `fontified`, as for a
 * source block, the text's faces are taken as they are.
 */
export function htmlizeRegionForPaste(start: number, end: number, fontified = false): string {
  const bindings = { "htmlize-output-type": e8.variable("org-html-htmlize-output-type") ?? null, "htmlize-css-name-prefix": e8.variable("org-html-htmlize-font-prefix") ?? "" };
  return e8.letBind(bindings, () => {
    const html = htmlizeRegion(start, end, { fontified });
    try {
      return e8.withCurrentBuffer(html, () => {
        const places = e8.variable("htmlize-buffer-places") as e8.Value[];
        const at = (place: string) => Number(places[places.findIndex((p) => typeof p === "symbol" && e8.symbolName(p) === place) + 1]);
        return e8.bufferSubstringNoProperties(at("content-start"), at("content-end"));
      });
    } finally {
      e8.call("kill-buffer", html);
    }
  });
}

/**
 * Code as HTML, as org-html-fontify-code: coloured by htmlize in its
 * language's mode, which org-src-lang-modes names, in the faces that mode
 * gives it; only escaped with no language, no such mode, or
 * org-html-htmlize-output-type nil.
 */
export function fontifyCode(code: string | undefined, lang?: string): string | undefined {
  if (code === undefined) return undefined;
  if (!lang || !nonNil(varValue("org-html-htmlize-output-type"))) return encodePlainText(code);
  const mode = langMode(lang);
  if (!e8.fboundp(mode)) return encodePlainText(code);
  const name = e8.generateNewBufferName(" *Org HTML fontify*");
  e8.getBufferCreate(name);
  let html: string;
  try {
    html = e8.withCurrentBuffer(name, () =>
      e8.letBind({ "inhibit-read-only": true }, () => {
        e8.bufferDisableUndo();
        e8.call(mode as e8.CommandName);
        e8.insert(code);
        e8.call("font-lock-ensure");
        // A tree-sitter mode's faces come from its syntax tree, not properties, until asked for.
        const end = e8.pointMax();
        if (e8.treesitLanguage() !== undefined) e8.treesitFontLockFontifyRegion(e8.pointMin(), end);
        // No face on the newlines, so that no span goes on to the next line.
        let p = e8.pointMin();
        for (const ch of code) {
          if (ch === "\n") e8.putTextProperty(p, p + 1, "face", null);
          p++;
        }
        e8.setBufferModified(false);
        return htmlizeRegionForPaste(e8.pointMin(), end, true);
      }),
    );
  } finally {
    e8.call("kill-buffer", name);
  }
  // Without the enclosing <pre></pre> tags.
  const beg = /^<pre[^>]*>\n?/.exec(html);
  return beg && html.endsWith("</pre>") ? html.slice(beg[0].length, html.length - "</pre>".length) : html;
}

function doFormatCode(code: string, lang?: string, refs: [number, string][] = [], retainLabels = false, numStart?: number, wrapLines = false): string {
  const lines = code.split("\n");
  const numWidth = numStart !== undefined ? String(lines.length + numStart).length : 0;
  const fontified = fontifyCode(code, lang)!;
  return formatCode(
    fontified,
    (loc, lineNum, ref) => {
      let l =
        (numStart !== undefined ? `<span class="linenr">${String(lineNum).padStart(numWidth)}: </span>` : "") +
        (wrapLines ? `<code${numStart !== undefined ? ` data-ox-html-linenr="${lineNum}"` : ""}>${loc}</code>` : loc) +
        (ref && retainLabels ? ` (${ref})` : "");
      if (ref) l = `<span id="coderef-${ref}" class="coderef-off">${l}</span>`;
      return l;
    },
    numStart,
    refs,
  );
}

function formatCodeOf(element: Node, info: Info): string {
  const [code, refs] = unravelCode(element);
  return doFormatCode(code, element.p.language, refs, nonNil(element.p["retain-labels"]), getLoc(element, info), nonNil(info["html-wrap-src-lines"]));
}

// --- Tables of contents ---------------------------------------------------------

export function toc(depth: any, info: Info, scope?: Datum): string | undefined {
  const entries: [string, number][] = collectHeadlines(info, depth, scope).map((h) => [formatTocHeadline(h, info), getRelativeLevel(h, info)]);
  if (entries.length === 0) return undefined;
  const counter: number | undefined = info["org-html--toc-counter"];
  const suffix = counter ? `-${counter}` : "";
  const t = `<div id="text-table-of-contents${suffix}" role="doc-toc">` + tocText(entries) + "</div>\n";
  info["org-html--toc-counter"] = (counter ?? 0) + 1;
  if (scope) return t;
  const outer = html5FancyP(info) ? "nav" : "div";
  const top = info["html-toplevel-hlevel"];
  return format('<%s id="table-of-contents%s" role="doc-toc">\n', outer, suffix) + format("<h%d>%s</h%d>\n", top, translateHtml("Table of Contents", info), top) + t + format("</%s>\n", outer);
}

function tocText(entries: [string, number][]): string {
  let prev = entries[0][1] - 1;
  const start = prev;
  let out = "";
  for (const [headline, level] of entries) {
    const cnt = level - prev;
    const times = cnt > 0 ? cnt - 1 : -cnt;
    prev = level;
    out += (cnt > 0 ? "\n<ul>\n<li>" : cnt < 0 ? "</li>\n</ul>\n" : "").repeat(times) + (cnt > 0 ? "\n<ul>\n<li>" : "</li>\n<li>") + headline;
  }
  return out + "</li>\n</ul>\n".repeat(prev - start);
}

function formatTocHeadline(headline: Node, info: Info): string {
  const number = getHeadlineNumber(headline, info);
  const todoKeyword = headline.p["todo-keyword"];
  const todo = nonNil(info["with-todo-keywords"]) && todoKeyword ? data(todoKeyword, info) : undefined;
  const todoType = todo ? headline.p["todo-type"] : undefined;
  const priority = nonNil(info["with-priority"]) ? headline.p.priority : undefined;
  const text = dataWithBackend(getAltTitle(headline, info), tocEntryBackend("html"), info);
  const tags = info["with-tags"] === true ? getTags(headline, info) : undefined;
  return format(
    '<a href="#%s">%s</a>',
    reference(headline, info),
    (lowLevelP(headline, info) === undefined && numberedHeadlineP(headline, info) ? number!.join(".") + ". " : "") +
      callFunction(info["html-format-headline-function"], HEADLINE_FUNCTIONS, todo, todoType, priority, text, tags, undefined),
  );
}

function listOf(kind: "listings" | "tables", info: Info): string | undefined {
  const entries = kind === "listings" ? collectListings(info) : collectTables(info);
  if (entries.length === 0) return undefined;
  const top = info["html-toplevel-hlevel"];
  const [title, numberFmt, cls] = kind === "listings" ? ["List of Listings", "Listing %d:", "listing-number"] : ["List of Tables", "Table %d:", "table-number"];
  let count = 0;
  const initial = `<span class="${cls}">${translateHtml(numberFmt, info)}</span>`;
  const items = entries.map((entry) => {
    const label = reference(entry, info, true);
    const t = trim(data(getCaption(entry, true) ?? getCaption(entry), info));
    count++;
    return "<li>" + (!label ? format(initial, count) + " " + t : format('<a href="#%s">%s %s</a>', label, format(initial, count), t)) + "</li>";
  });
  return `<div id="list-of-${kind}">\n` + format("<h%d>%s</h%d>\n", top, translateHtml(title, info), top) + `<div id="text-list-of-${kind}">\n<ul>\n` + items.join("\n") + "\n</ul>\n</div>\n</div>";
}

// --- Transcoders ------------------------------------------------------------------

const markup = (info: Info, type: string, contents: string) => format(assoc(info["html-text-markup-alist"], type)?.[1] ?? "%s", contents);

/** The default heading format, as org-html-format-headline-default-function. */
export function formatHeadlineDefault(todo: string | undefined, todoType: string | undefined, priority: any, text: string, tags: string[] | undefined, info?: Info): string {
  const t = todoHtml(todo, todoType, info);
  const p = priorityHtml(priority);
  const g = tagsHtml(tags, info);
  return (t ? t + " " : "") + (p ? p + " " : "") + text + (g ? "&#xa0;&#xa0;&#xa0;" + g : "");
}
e8.defun("org-html-format-headline-default-function", (...args: any[]) => (formatHeadlineDefault as any)(...args));

function formatInlinetaskDefault(todo: string | undefined, todoType: string | undefined, priority: any, text: string, tags: string[] | undefined, contents: string | undefined, info: Info): string {
  return format('<div class="inlinetask">\n<b>%s</b>%s\n%s</div>', formatHeadlineDefault(todo, todoType, priority, text, tags, info), closeTag("br", undefined, info), contents ?? "");
}
e8.defun("org-html-format-inlinetask-default-function", (...args: any[]) => (formatInlinetaskDefault as any)(...args));
e8.defun("org-html-format-drawer-default-function", (_name: string, contents: string) => contents);

const HEADLINE_FUNCTIONS = { "org-html-format-headline-default-function": formatHeadlineDefault };

function checkbox(cb: string | undefined, info: Info): string | undefined {
  if (!cb) return undefined;
  return assoc(assoc(HTML_CHECKBOX_TYPES, info["html-checkbox-type"])?.slice(1), cb)?.[1];
}

/** A list item, as org-html-format-list-item. */
export function formatListItem(contents: string | undefined, type: string, cb: string | undefined, info: Info, termCounterId?: string | number, headline?: string): string {
  const cls = cb ? ` class="${cb}"` : "";
  const box = (checkbox(cb, info) ?? "") + (cb ? " " : "");
  const br = closeTag("br", undefined, info);
  const extraNewline = nw(contents) && headline ? "\n" : "";
  let out = "";
  if (type === "ordered") out += `<li${cls}${termCounterId !== undefined ? ` value="${termCounterId}"` : ""}>` + (headline ? headline + br : "");
  else if (type === "unordered") out += `<li${cls}${termCounterId !== undefined ? ` id="${termCounterId}"` : ""}>` + (headline ? headline + br : "");
  else out += `<dt${cls}>${box}${termCounterId ?? "(no term)"}</dt><dd>`;
  if (type !== "descriptive") out += box;
  out += extraNewline + (nw(contents) ? trim(contents) : "") + extraNewline;
  return out + (type === "descriptive" ? "</dd>" : "</li>");
}

function headline(h: Node, contents: string | undefined, info: Info): string | undefined {
  if (nonNil(h.p["footnote-section-p"])) return undefined;
  const numberedp = numberedHeadlineP(h, info);
  const numbers = getHeadlineNumber(h, info);
  const level = getRelativeLevel(h, info) + (info["html-toplevel-hlevel"] - 1);
  const todo = nonNil(info["with-todo-keywords"]) && h.p["todo-keyword"] ? data(h.p["todo-keyword"], info) : undefined;
  const todoType = todo ? h.p["todo-type"] : undefined;
  const priority = nonNil(info["with-priority"]) ? h.p.priority : undefined;
  const text = data(h.p.title, info);
  const tags = nonNil(info["with-tags"]) ? getTags(h, info) : undefined;
  const fullText = callFunction(info["html-format-headline-function"], HEADLINE_FUNCTIONS, todo, todoType, priority, text, tags && tags.length ? tags : undefined, info);
  const c = contents ?? "";
  const id = reference(h, info)!;
  const formatted = nonNil(info["html-self-link-headlines"]) ? `<a href="#${id}">${fullText}</a>` : fullText;
  if (lowLevelP(h, info) !== undefined) {
    const htmlType = numberedp ? "ol" : "ul";
    return (
      (firstSiblingP(h, info) ? `<${htmlType} class="org-${htmlType}">\n` : "") +
      formatListItem(c, numberedp ? "ordered" : "unordered", undefined, info, undefined, htmlAnchor(id, undefined, undefined, info) + formatted) +
      "\n" +
      (lastSiblingP(h, info) ? `</${htmlType}>\n` : "")
    );
  }
  const extraClass = h.p.HTML_CONTAINER_CLASS;
  const headlineClass = h.p.HTML_HEADLINE_CLASS;
  const first = h.contents[0];
  const container = htmlContainer(h, info);
  return format(
    '<%s id="%s" class="%s">%s%s</%s>\n',
    container,
    `outline-container-${id}`,
    `outline-${level}` + (extraClass ? " " + extraClass : ""),
    format(
      '\n<h%d id="%s"%s>%s</h%d>\n',
      level,
      id,
      headlineClass ? ` class="${headlineClass}"` : "",
      (numberedp ? `<span class="section-number-${level}">${numbers!.join(".")}.</span> ` : "") + formatted,
      level,
    ),
    typeOf(first) === "section" ? c : section(first as Node, "", info) + c,
    container,
  );
}

function htmlContainer(h: Node, info: Info): string {
  return h.p.HTML_CONTAINER ?? (getRelativeLevel(h, info) === 1 ? info["html-container"] : "div");
}

function section(s: Node, contents: string | undefined, info: Info): string | undefined {
  const parent = ancestor(s, ["headline"]) as Node | undefined;
  if (!parent) return contents;
  const classNum = getRelativeLevel(parent, info) + (info["html-toplevel-hlevel"] - 1);
  const sectionNumber = numberedHeadlineP(parent, info) ? getHeadlineNumber(parent, info)?.join("-") : undefined;
  return format('<div class="outline-text-%d" id="text-%s">\n%s</div>\n', classNum, parent.p.CUSTOM_ID ?? sectionNumber ?? getReference(parent, info), contents ?? "");
}

function item(i: Node, contents: string | undefined, info: Info): string {
  const list = i.parent!;
  const tag = i.p.tag ? data(i.p.tag, info) : undefined;
  return formatListItem(contents, list.p.type, i.p.checkbox, info, tag ?? i.p.counter ?? undefined);
}

function keyword(k: Node, _c: unknown, info: Info): string | undefined {
  const key = k.p.key;
  const value: string = k.p.value ?? "";
  if (key === "HTML") return value;
  if (key === "TOC") {
    if (/\bheadlines\b/i.test(value)) {
      const d = /\b[0-9]+\b/.exec(value);
      const depth = d ? parseInt(d[0], 10) : undefined;
      const t = /:target +(".+?"|\S+)/i.exec(value);
      const scope = t ? (resolveLink(t[1].replace(/^"(.*)"$/, "$1"), info) as Datum) : /\blocal\b/i.test(value) ? k : undefined;
      return toc(depth, info, scope);
    }
    if (value === "listings") return listOf("listings", info);
    if (value === "tables") return listOf("tables", info);
  }
  return undefined;
}

/** LaTeX for MathJax: $...$ as \(...\) and $$...$$ as \[...\], as org-format-latex prepares it. */
function formatLatex(frag: string, processingType: string, _info: Info): string {
  if (processingType === "mathjax") {
    const m = /^\$\$?/.exec(frag);
    if (!m) return frag;
    return m[0] === "$$" ? "\\[" + frag.slice(2, -2) + "\\]" : "\\(" + frag.slice(1, -1) + "\\)";
  }
  if (processingType === "html") e8.userError("E8 cannot convert LaTeX to MathML yet (org-latex-to-html-convert-command)");
  return e8.userError(`E8 cannot make images of LaTeX yet: use tex:t or tex:verbatim instead of ${processingType}`);
}

const MATH_ENVIRONMENT = /^[ \t]*\\begin\{(?:equation|eqnarray|math|displaymath|align|gather|multline|flalign|alignat|xalignat|xxalignat|subequations|dmath|dseries|dgroup|darray|dsuspend)\*?\}/;

function mathEnvironmentP(element: Datum): boolean {
  return MATH_ENVIRONMENT.test(String(property("value", element)));
}

function latexEnvironmentNumberedP(element: Datum): boolean {
  return !/^[ \t]*\\begin\{(.*\*|displaymath)\}/.test(String(property("value", element)));
}

function wrapLatexEnvironment(contents: string, caption?: string, label?: string): string {
  return format(
    '\n<div%s class="equation-container">\n%s%s\n</div>',
    nw(label) ? ` id="${label}"` : "",
    format('<span class="equation">\n%s\n</span>', contents),
    !nw(caption) ? "" : format('\n<span class="equation-label">\n%s\n</span>', caption),
  );
}

function latexEnvironment(env: Node, _c: unknown, info: Info): string {
  const processingType = info["with-latex"];
  const frag = removeIndentation(env.p.value);
  const label = reference(env, info, true);
  const caption =
    latexEnvironmentNumberedP(env) && mathEnvironmentP(env)
      ? String(getOrdinal(env, info, undefined, (l) => mathEnvironmentP(l) && latexEnvironmentNumberedP(l)))
      : undefined;
  if (processingType === true || processingType === "mathjax") return formatLatex(nw(label) ? frag.replace(/^.*/, (m) => `${m}\n\\label{${label}}`) : frag, "mathjax", info);
  if (nonNil(processingType) && processingType !== "verbatim" && processingType !== "html") formatLatex(frag, String(processingType), info);
  return wrapLatexEnvironment(frag, caption, label);
}

function latexFragment(f: Node, _c: unknown, info: Info): string {
  const frag: string = f.p.value;
  const processingType = info["with-latex"];
  if (processingType === true || processingType === "mathjax") return formatLatex(frag, "mathjax", info);
  if (processingType === "html") return formatLatex(frag, "html", info);
  if (nonNil(processingType) && processingType !== "verbatim") return formatLatex(frag, String(processingType), info);
  return frag;
}

/** Whether a link is an inline image, as org-html-inline-image-p: one with no description, or a description that is only an image link. */
export function inlineImageHtmlP(link: Node, info: Info): boolean {
  if (link.contents.length === 0) return inlineImageP(link, info["html-inline-image-rules"]);
  let linkCount = 0;
  return !mapFirst(
    link.contents,
    ["plain-text", ...ALL_OBJECTS],
    (obj) => {
      const t = typeOf(obj);
      if (t === "plain-text") return nw(obj);
      if (t === "link") {
        if (linkCount === 1) return true;
        linkCount++;
        return !inlineImageP(obj as Node, info["html-inline-image-rules"]);
      }
      return true;
    },
    mapOpts(info),
  );
}

/** Whether a paragraph, or a link's paragraph, is an image alone, as org-html-standalone-image-p. */
export function standaloneImageP(element: Datum, info: Info, predicate?: (p: Node) => boolean): boolean {
  const type = typeOf(element);
  const paragraph = type === "paragraph" ? (element as Node) : type === "link" ? (element as Node).parent : undefined;
  if (!paragraph || paragraph.type !== "paragraph") return false;
  if (predicate && !predicate(paragraph)) return false;
  let linkCount = 0;
  const bad = mapFirst(
    paragraph.contents,
    ["plain-text", ...ALL_OBJECTS],
    (obj) => {
      const t = typeOf(obj);
      if (t === "plain-text") return nw(obj);
      if (t === "link") return ++linkCount > 1 || !inlineImageHtmlP(obj as Node, info);
      return true;
    },
    mapOpts(info, { noRecursion: ["link"] }),
  );
  return !bad && linkCount === 1;
}

/** A character's UTF-8 bytes. */
function utf8Bytes(ch: string): number[] {
  const c = ch.codePointAt(0)!;
  if (c < 0x80) return [c];
  if (c < 0x800) return [0xc0 | (c >> 6), 0x80 | (c & 63)];
  if (c < 0x10000) return [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
  return [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
}

/** A URL with the characters URLs cannot hold percent-encoded, as url-encode-url. */
export function urlEncodeUrl(url: string): string {
  let out = "";
  for (const ch of url) {
    if (/[A-Za-z0-9\-._~!$&'()*+,;=:@/?#%[\]]/.test(ch)) out += ch;
    else for (const b of utf8Bytes(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function parentElement(d: Node): Node | undefined {
  let up = d.parent;
  while (up && ALL_OBJECTS.includes(up.type)) up = up.parent;
  return up;
}

function link(l: Node, desc: string | undefined, info: Info): string | undefined {
  const ext = String(info["html-extension"] ?? "");
  const dot = ext.length > 0 ? "." : "";
  const orgAsHtml = (rawPath: string) => {
    const m = nonNil(info["html-link-org-files-as-html"]) ? /^(.+)\.org(?:\.gpg)?$/i.exec(rawPath) : null;
    return m ? m[1] + dot + ext : rawPath;
  };
  const type: string = l.p.type;
  let rawPath: string = l.p.path;
  const d = nw(desc) ? desc : undefined;
  let path: string;
  if (type === "file") {
    rawPath = fileUri(publishFileRelativeName(rawPath, info));
    const home = info["html-link-home"] ? trim(String(info["html-link-home"])) : undefined;
    if (home && nonNil(info["html-link-use-abs-url"]) && !e8.fileNameAbsoluteP(rawPath)) rawPath = e8.fileNameAsDirectory(home) + rawPath;
    rawPath = orgAsHtml(rawPath);
    const option = l.p["search-option"];
    path = option ? rawPath + "#" + publishResolveExternalLink(option, l.p.path, true) : rawPath;
  } else path = urlEncodeUrl(type + ":" + rawPath);
  const parent = parentElement(l);
  const container = l.parent;
  const linkForAttr = container && container.type === "link" && inlineImageHtmlP(l, info) ? container : l;
  const attributesPlist = {
    ...(parent && mapFirst(parent, "link", (x) => x, mapOpts(info)) === linkForAttr ? readAttribute("attr_html", parent) ?? {} : {}),
    ...(readAttribute("attr_html", l) ?? {}),
  };
  const attr = makeAttributeString(attributesPlist);
  const attributes = nw(attr) ? " " + attr : "";
  const custom = customProtocolMaybe(l, d, "html", info);
  if (custom !== undefined) return custom;
  if (nonNil(info["html-inline-images"]) && inlineImageP(l, info["html-inline-image-rules"])) return formatImage(path, attributesPlist, info);
  if (type === "radio") {
    const destination = resolveRadioLink(l, info);
    return !destination ? d : format('<a href="#%s"%s>%s</a>', getReference(destination, info), attributes, d);
  }
  if (type === "custom-id" || type === "fuzzy" || type === "id") {
    const destination = type === "fuzzy" ? resolveFuzzyLink(l, info) : resolveIdLink(l, info);
    if (typeof destination === "string") {
      const fragment = HTML_ID_ATTR_PREFIX + rawPath;
      return format('<a href="%s#%s"%s>%s</a>', orgAsHtml(destination), fragment, attributes, d ?? destination);
    }
    if (!destination) return format("<i>%s</i>", d ?? data(l.p["raw-link"], info));
    if (typeOf(destination) === "headline") {
      const href = reference(destination, info);
      const text = numberedHeadlineP(destination as Node, info) && !d ? getHeadlineNumber(destination as Node, info)!.join(".") : d ?? data((destination as Node).p.title, info);
      return format('<a href="#%s"%s>%s</a>', href, attributes, text);
    }
    if ((info["with-latex"] === "mathjax" || info["with-latex"] === true) && typeOf(destination) === "latex-environment" && mathEnvironmentP(destination))
      return format(info["html-equation-reference-format"], reference(destination, info));
    const ref = reference(destination, info);
    const counterPredicate = typeOf(destination) === "latex-environment" ? mathEnvironmentP : hasCaptionP;
    let number: any;
    if (!d) {
      if (standaloneImageP(destination, info, hasCaptionP))
        number = getOrdinal(mapFirst(destination, "link", (x) => x, mapOpts(info))!, info, ["link"], (x, i) => standaloneImageP(x, i, hasCaptionP));
      else number = getOrdinal(destination, info, undefined, (x) => counterPredicate(x));
    }
    const text = d ?? (number === undefined ? "No description for this link" : Array.isArray(number) ? number.join(".") : String(number));
    return format('<a href="#%s"%s>%s</a>', ref, attributes, text);
  }
  if (type === "coderef") {
    const fragment = "coderef-" + encodePlainText(rawPath);
    return format(
      '<a href="#%s" %s%s>%s</a>',
      fragment,
      format("class=\"coderef\" onmouseover=\"CodeHighlightOn(this, '%s');\" onmouseout=\"CodeHighlightOff(this, '%s');\"", fragment, fragment),
      attributes,
      format(getCoderefFormat(rawPath, d), resolveCoderef(rawPath, info)),
    );
  }
  if (path && d) return format('<a href="%s"%s>%s</a>', encodePlainText(path), attributes, d);
  if (path) {
    const p = encodePlainText(path);
    return format('<a href="%s"%s>%s</a>', p, attributes, p);
  }
  return format("<i>%s</i>", d);
}

function paragraph(p: Node, contents: string, info: Info): string {
  const parent = p.parent;
  const parentType = parent?.type;
  const attributes = makeAttributeString(readAttribute("attr_html", p));
  const extra = parentType === "footnote-definition" || parentType === "org-data" ? ' class="footpara"' : "";
  if (parentType === "item" && !getPreviousElement(p, info)) {
    const followers = getNextElements(p, info).slice(0, 2);
    if (followers.length <= 1 && (followers.length === 0 || typeOf(followers[0]) === "plain-list")) return contents;
  }
  if (standaloneImageP(p, info)) {
    const raw = data(getCaption(p) ?? [], info);
    const caption = !nw(raw)
      ? raw
      : '<span class="figure-number">' +
        format(translateHtml("Figure %d:", info), getOrdinal(mapFirst(p, "link", (x) => x, mapOpts(info))!, info, undefined, (x, i) => standaloneImageP(x, i, hasCaptionP))) +
        " </span>" +
        raw;
    return wrapImage(contents, info, caption, reference(p, info));
  }
  return format("<p%s%s>\n%s</p>", nw(attributes) ? " " + attributes : "", extra, contents);
}

function plainList(l: Node, contents: string, info: Info): string {
  const type = { ordered: "ol", unordered: "ul", descriptive: "dl" }[l.p.type as string];
  if (!type) e8.signal("error", `Unknown HTML list type: ${l.p.type}`);
  const attributes = readAttribute("attr_html", l) ?? {};
  attributes[":class"] = trim([`org-${type}`, attributes[":class"] ?? ""].join(" "));
  void info;
  return format("<%s %s>\n%s</%s>", type, makeAttributeString(attributes), contents, type);
}

/** Org's special strings in HTML: \- as a soft hyphen, -- and --- as dashes, ... as an ellipsis, as org-html-convert-special-strings. */
export function convertSpecialStrings(s: string): string {
  return s
    .replace(/\\-/g, "&#x00ad;")
    .replace(/---([^-])/g, "&#x2014;$1")
    .replace(/--([^-])/g, "&#x2013;$1")
    .replace(/\.\.\./g, "&#x2026;");
}

/** Text with &, < and > as entities, as org-html-encode-plain-text with org-html-protect-char-alist. */
export function encodePlainText(text: string): string {
  const alist = varValue("org-html-protect-char-alist");
  for (const [from, to] of Array.isArray(alist) ? alist : []) text = text.split(String(from)).join(String(to));
  return text;
}

function plainText(text: string, info: Info): string {
  let output = encodePlainText(text);
  if (nonNil(info["with-smart-quotes"])) output = activateSmartQuotes(output, "html", info);
  if (nonNil(info["with-special-strings"])) output = convertSpecialStrings(output);
  if (nonNil(info["preserve-breaks"])) output = output.replace(/(\\\\)?[ \t]*\n/g, closeTag("br", undefined, info) + "\n");
  return output;
}

/** A timestamp as written, as org-timestamp-translate without custom times. */
export function timestampTranslate(ts: Node): string {
  return interpretData(ts);
}

function planning(p: Node, _c: unknown, info: Info): string {
  const pairs: [string, Node | undefined][] = [
    [String(varValue("org-closed-string") || "CLOSED:"), p.p.closed],
    [String(varValue("org-deadline-string") || "DEADLINE:"), p.p.deadline],
    [String(varValue("org-scheduled-string") || "SCHEDULED:"), p.p.scheduled],
  ];
  return format(
    '<p><span class="timestamp-wrapper">%s</span></p>',
    trim(pairs.map(([s, ts]) => (ts ? format('<span class="timestamp-kwd">%s</span> <span class="timestamp">%s</span> ', s, plainText(timestampTranslate(ts), info)) : "")).join("")),
  );
}

function withId(attributes: { [k: string]: any }, ref: string | undefined): { [k: string]: any } {
  if (!ref || ":id" in attributes) return attributes;
  return { ...attributes, ":id": ref };
}

function specialBlock(b: Node, contents: string | undefined, info: Info): string {
  const blockType: string = b.p.type;
  const fancy = html5FancyP(info) && HTML_HTML5_ELEMENTS.includes(blockType);
  let attributes = readAttribute("attr_html", b) ?? {};
  if (!fancy) attributes = { ...attributes, ":class": attributes[":class"] ? `${attributes[":class"]} ${blockType}` : blockType };
  const a = makeAttributeString(withId(attributes, reference(b, info)));
  const s = nw(a) ? " " + a : "";
  return fancy ? format("<%s%s>\n%s</%s>", blockType, s, contents ?? "", blockType) : format("<div%s>\n%s\n</div>", s, contents ?? "");
}

function srcBlock(b: Node, _c: unknown, info: Info): string {
  if (nonNil(readAttribute("attr_html", b, ":textarea"))) return textareaBlock(b);
  const lang = b.p.language;
  const code = formatCodeOf(b, info);
  const lbl = reference(b, info, true);
  const label = lbl ? ` id="${lbl}"` : "";
  const klipsify = nonNil(info["html-klipsify-src"]) && ["javascript", "js", "ruby", "scheme", "clojure", "php", "html"].includes(lang);
  const caption = getCaption(b);
  return format(
    '<div class="org-src-container">\n%s%s\n</div>',
    !caption
      ? ""
      : format(
          '<label class="org-src-name">%s%s</label>',
          format('<span class="listing-number">%s </span>', format(translateHtml("Listing %d:", info), getOrdinal(b, info, undefined, hasCaptionP))),
          trim(data(caption, info)),
        ),
    klipsify
      ? format('<pre><code class="src src-%s"%s%s>%s</code></pre>', lang, label, lang === "html" ? ' data-editor-type="html"' : "", code)
      : format('<pre class="src src-%s"%s>%s</pre>', lang, label, code),
  );
}

function tableCell(cell: Node, contents: string | undefined, info: Info): string {
  const row = cell.parent!;
  const table = ancestor(cell, ["table"]) as Node;
  const cellAttrs = !nonNil(info["html-table-align-individual-fields"]) ? "" : format(' class="org-%s"', tableCellAlignment(cell, info));
  const c = !contents || trim(contents) === "" ? "&#xa0;" : contents;
  if (tableHasHeaderP(table, info) && tableRowGroup(row, info) === 1) {
    const tags = info["html-table-header-tags"];
    return "\n" + format(tags[0], "col", cellAttrs) + c + tags[1];
  }
  if (nonNil(info["html-table-use-header-tags-for-first-column"]) && tableCellAddress(cell, info)?.[1] === 0) {
    const tags = info["html-table-header-tags"];
    return "\n" + format(tags[0], "row", cellAttrs) + c + tags[1];
  }
  const tags = info["html-table-data-tags"];
  return "\n" + format(tags[0], cellAttrs) + c + tags[1];
}

function tableRow(row: Node, contents: string | undefined, info: Info): string | undefined {
  if (row.p.type !== "standard") return undefined;
  const group = tableRowGroup(row, info);
  const number = tableRowNumber(row, info);
  const start = tableRowStartsRowgroupP(row, info);
  const end = tableRowEndsRowgroupP(row, info);
  const tag = (v: any) => (typeof v === "function" ? v(number, group, start, end, false, false) : typeof v === "string" ? v : String(v ?? ""));
  const open = tag(info["html-table-row-open-tag"]);
  const close = tag(info["html-table-row-close-tag"]);
  const groupTags: [string, string] =
    group !== 1 ? ["<tbody>", "\n</tbody>"] : tableHasHeaderP(ancestor(row, ["table"]) as Node, info) ? ["<thead>", "\n</thead>"] : ["<tbody>", "\n</tbody>"];
  return (start ? groupTags[0] : "") + "\n" + open + (contents ?? "") + "\n" + close + (end ? groupTags[1] : "");
}

function tableFirstRowDataCells(table: Node, info: Info): Node[] {
  const row = mapFirst(table, "table-row", (r) => (property("type", r) === "rule" ? undefined : (r as Node)), mapOpts(info));
  const cells = contentsOf(row) as Node[];
  return tableHasSpecialColumnP(table) ? cells.slice(1) : cells;
}

function table(t: Node, contents: string | undefined, info: Info): string | undefined {
  if (t.p.type === "table.el") return e8.userError("E8 cannot export table.el tables to HTML yet");
  const caption = getCaption(t);
  const number = getOrdinal(t, info, undefined, hasCaptionP);
  const attributes = makeAttributeString({
    ":id": reference(t, info, true),
    ...(!html5P(info) ? plistObject(info["html-table-attributes"]) : {}),
    ...(readAttribute("attr_html", t) ?? {}),
  });
  const specs = tableFirstRowDataCells(t, info)
    .map(
      (cell) =>
        (tableCellStartsColgroupP(cell, info) ? "\n<colgroup>" : "") +
        "\n" +
        closeTag("col", " " + format('class="org-%s"', tableCellAlignment(cell, info)), info) +
        (tableCellEndsColgroupP(cell, info) ? "\n</colgroup>" : ""),
    )
    .join("\n");
  return format(
    "<table%s>\n%s\n%s\n%s</table>",
    attributes === "" ? "" : " " + attributes,
    !caption
      ? ""
      : format(
          nonNil(info["html-table-caption-above"]) ? '<caption class="t-above">%s</caption>' : '<caption class="t-bottom">%s</caption>',
          '<span class="table-number">' + format(translateHtml("Table %d:", info), number) + "</span> " + data(caption, info),
        ),
    specs,
    contents ?? "",
  );
}

/** A property list, flat as Lisp writes it, as an object of its keys. */
function plistObject(plist: any): { [k: string]: any } {
  const out: { [k: string]: any } = {};
  if (Array.isArray(plist)) for (let i = 0; i + 1 < plist.length; i += 2) out[String(plist[i])] = plist[i + 1];
  return out;
}

function verseBlock(_v: Node, contents: string, info: Info): string {
  const br = closeTag("br", undefined, info);
  const escaped = br.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withBreaks = contents.replace(new RegExp(`(?:${escaped})?[ \\t]*\\n`, "g"), br + "\n");
  return format('<p class="verse">\n%s</p>', withBreaks.replace(/^[ \t]+/gm, (m) => "&#xa0;".repeat(m.length)));
}

function exampleBlock(b: Node, _c: unknown, info: Info): string {
  let attributes = readAttribute("attr_html", b) ?? {};
  if (nonNil(attributes[":textarea"])) return textareaBlock(b);
  attributes = { ...attributes, ":class": attributes[":class"] ? "example " + attributes[":class"] : "example" };
  const a = makeAttributeString(withId(attributes, reference(b, info)));
  return format("<pre%s>\n%s</pre>", nw(a) ? " " + a : "", formatCodeOf(b, info));
}

function footnoteReference(ref: Node, _c: unknown, info: Info): string {
  const prev = getPreviousElement(ref, info);
  const sep = typeOf(prev) === "footnote-reference" ? info["html-footnote-separator"] : "";
  const n = getFootnoteNumber(ref, info);
  const given = ref.p.label;
  const label = typeof given === "string" && given === String(parseInt(given, 10) || 0) ? undefined : given;
  const id = format(
    "fnr.%s%s",
    label ?? n,
    footnoteFirstReferenceP(ref, info)
      ? ""
      : "." + getOrdinal(ref, info, ["footnote-reference"], (r) => (given ? property("label", r) === given : !property("label", r))),
  );
  return sep + format(info["html-footnote-format"], htmlAnchor(id, String(n), format(' class="footref" href="#fn.%s" role="doc-backlink"', label ?? n), info));
}

function inlinetask(t: Node, contents: string | undefined, info: Info): string {
  const todo = nonNil(info["with-todo-keywords"]) && t.p["todo-keyword"] ? data(t.p["todo-keyword"], info) : undefined;
  const todoType = todo ? t.p["todo-type"] : undefined;
  const priority = nonNil(info["with-priority"]) ? t.p.priority : undefined;
  const text = data(t.p.title, info);
  const tags = nonNil(info["with-tags"]) ? getTags(t, info) : undefined;
  return callFunction(info["html-format-inlinetask-function"], { "org-html-format-inlinetask-default-function": formatInlinetaskDefault }, todo, todoType, priority, text, tags && tags.length ? tags : undefined, contents, info);
}

function inlineSrcBlock(b: Node, _c: unknown, info: Info): string {
  const lang = b.p.language;
  const lbl = reference(b, info, true);
  return format('<code class="src src-%s"%s>%s</code>', lang, lbl ? ` id="${lbl}"` : "", fontifyCode(b.p.value, lang));
}

function finalFunction(contents: string, _backend: string | undefined, info: Info): string {
  if (nonNil(info["html-indent"])) {
    const name = e8.generateNewBufferName(" *Org HTML indent*");
    e8.getBufferCreate(name);
    try {
      return e8.withCurrentBuffer(name, () => {
        e8.insert(contents);
        e8.call("indent-region" as any, 0, e8.pointMax());
        return e8.bufferText();
      });
    } finally {
      e8.call("kill-buffer", name);
    }
  }
  return contents;
}

// --- The backend ---------------------------------------------------------------------

const T = (fn: (...args: any[]) => any) => fn;

export const HTML_TRANSCODERS: Backend["transcoders"] = {
  bold: T((_b, c, info) => markup(info, "bold", c)),
  "center-block": T((_b, c) => format('<div class="org-center">\n%s</div>', c)),
  clock: T((clock: Node) =>
    format(
      '<p>\n<span class="timestamp-wrapper">\n<span class="timestamp-kwd">%s</span> <span class="timestamp">%s</span>%s\n</span>\n</p>',
      varValue("org-clock-string") || "CLOCK:",
      timestampTranslate(clock.p.value),
      clock.p.duration ? format(' <span class="timestamp">(%s)</span>', clock.p.duration) : "",
    ),
  ),
  code: T((c: Node, _x, info) => markup(info, "code", encodePlainText(c.p.value))),
  drawer: T((d: Node, c, info) => callFunction(info["html-format-drawer-function"], { "org-html-format-drawer-default-function": (_n: string, x: string) => x }, d.p["drawer-name"], c)),
  "dynamic-block": T((_d, c) => c),
  entity: T((e: Node) => e.p.html),
  "example-block": T(exampleBlock),
  "export-block": T((b: Node) => (b.p.type === "HTML" ? removeIndentation(b.p.value) : undefined)),
  "export-snippet": T((s: Node) => (snippetBackend(s) === "html" ? s.p.value : undefined)),
  "fixed-width": T((f: Node) => format('<pre class="example">\n%s</pre>', doFormatCode(removeIndentation(f.p.value)))),
  "footnote-reference": T(footnoteReference),
  headline: T(headline),
  "horizontal-rule": T((_h, _c, info) => closeTag("hr", undefined, info)),
  "inline-src-block": T(inlineSrcBlock),
  inlinetask: T(inlinetask),
  "inner-template": T(innerTemplate),
  italic: T((_i, c, info) => markup(info, "italic", c)),
  item: T(item),
  keyword: T(keyword),
  "latex-environment": T(latexEnvironment),
  "latex-fragment": T(latexFragment),
  "line-break": T((_l, _c, info) => closeTag("br", undefined, info) + "\n"),
  link: T(link),
  "node-property": T((p: Node) => format("%s:%s", p.p.key, p.p.value ? " " + p.p.value : "")),
  paragraph: T(paragraph),
  "plain-list": T(plainList),
  "plain-text": T(plainText),
  planning: T(planning),
  "property-drawer": T((_p, c) => (nw(c) ? format('<pre class="example">\n%s</pre>', c) : undefined)),
  "quote-block": T((q: Node, c, info) => {
    const a = makeAttributeString(withId(readAttribute("attr_html", q) ?? {}, reference(q, info, true)));
    return format("<blockquote%s>\n%s</blockquote>", nw(a) ? " " + a : "", c);
  }),
  "radio-target": T((r: Node, text, info) => htmlAnchor(reference(r, info), text, undefined, info)),
  section: T(section),
  "special-block": T(specialBlock),
  "src-block": T(srcBlock),
  "statistics-cookie": T((s: Node) => format("<code>%s</code>", s.p.value)),
  "strike-through": T((_s, c, info) => markup(info, "strike-through", c)),
  subscript: T((_s, c) => format("<sub>%s</sub>", c)),
  superscript: T((_s, c) => format("<sup>%s</sup>", c)),
  table: T(table),
  "table-cell": T(tableCell),
  "table-row": T(tableRow),
  target: T((t: Node, _c, info) => htmlAnchor(reference(t, info), undefined, undefined, info)),
  template: T(template),
  timestamp: T((ts: Node, _c, info) => format('<span class="timestamp-wrapper"><span class="timestamp">%s</span></span>', plainText(timestampTranslate(ts), info).replace(/--/g, "&#x2013;"))),
  underline: T((_u, c, info) => markup(info, "underline", c)),
  verbatim: T((v: Node, _c, info) => markup(info, "verbatim", encodePlainText(v.p.value))),
  "verse-block": T(verseBlock),
};

/** Make the links whose description is an image link images, as org-html-image-link-filter. */
function imageLinkFilter(tree: any, _backend: string | undefined, info: Info): any {
  return insertImageLinks(tree, info, info["html-inline-image-rules"]);
}

export function exportAsHtml(_async?: unknown, subtreep?: unknown, visibleOnly?: unknown, bodyOnly?: unknown, extPlist?: unknown): string {
  return toBuffer("html", "*Org HTML Export*", flag(subtreep), flag(visibleOnly), flag(bodyOnly), extPlistOf(extPlist));
}

export function exportToHtml(_async?: unknown, subtreep?: unknown, visibleOnly?: unknown, bodyOnly?: unknown, extPlist?: unknown): string {
  const ext = extPlistOf(extPlist);
  const htmlExt = String(varValue("org-html-extension") || "");
  const extension = (htmlExt.length > 0 ? "." : "") + (ext["html-extension"] ?? (htmlExt || "html"));
  const file = outputFileName(extension, flag(subtreep));
  return e8.letBind({ "org-export-coding-system": e8.variable("org-html-coding-system") ?? null }, () =>
    toFile("html", file, flag(subtreep), flag(visibleOnly), flag(bodyOnly), ext),
  );
}

/** An export command's ext-plist argument as an object: nothing when it was not given. */
export function extPlistOf(v: unknown): Info {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Info;
  if (Array.isArray(v)) return plistObject(v.map((x: any) => (typeof x === "symbol" ? e8.symbolName(x).replace(/^:/, "") : x)));
  return {};
}

/** Replace the active region, as Org text, by its export, as org-export-replace-region-by. */
export function replaceRegionBy(backend: string): void {
  const mark = e8.mark();
  if (mark === undefined || !nonNil(e8.variable("mark-active"))) e8.userError("No active region to replace");
  const from = Math.min(e8.point(), mark);
  const to = Math.max(e8.point(), mark);
  const text = e8.deleteRegion(from, to);
  e8.gotoChar(from);
  e8.insert(stringAs(text, backend, true));
}

defineBackend("html", HTML_TRANSCODERS, {
  filters: { "filter-parse-tree": imageLinkFilter, "filter-final-output": finalFunction },
  menu: [
    "h",
    "Export to HTML",
    [
      ["H", "As HTML buffer", exportAsHtml],
      ["h", "As HTML file", exportToHtml],
      ["o", "As HTML file and open", (a: boolean, s: boolean, v: boolean, b: boolean) => browseUrl("file://" + e8.expandFileName(exportToHtml(a, s, v, b)))],
    ],
  ],
  options: [
    ["html-doctype", "HTML_DOCTYPE", undefined, "org-html-doctype"],
    ["html-container", "HTML_CONTAINER", undefined, "org-html-container-element"],
    ["html-content-class", "HTML_CONTENT_CLASS", undefined, "org-html-content-class"],
    ["description", "DESCRIPTION", undefined, undefined, "newline"],
    ["keywords", "KEYWORDS", undefined, undefined, "space"],
    ["html-html5-fancy", undefined, "html5-fancy", "org-html-html5-fancy"],
    ["html-link-use-abs-url", undefined, "html-link-use-abs-url", "org-html-link-use-abs-url"],
    ["html-link-home", "HTML_LINK_HOME", undefined, "org-html-link-home"],
    ["html-link-up", "HTML_LINK_UP", undefined, "org-html-link-up"],
    ["html-mathjax", "HTML_MATHJAX", undefined, () => "", "space"],
    ["html-equation-reference-format", "HTML_EQUATION_REFERENCE_FORMAT", undefined, "org-html-equation-reference-format", "replace"],
    ["html-postamble", undefined, "html-postamble", "org-html-postamble"],
    ["html-preamble", undefined, "html-preamble", "org-html-preamble"],
    ["html-head", "HTML_HEAD", undefined, "org-html-head", "newline"],
    ["html-head-extra", "HTML_HEAD_EXTRA", undefined, "org-html-head-extra", "newline"],
    ["subtitle", "SUBTITLE", undefined, undefined, "parse"],
    ["html-head-include-default-style", undefined, "html-style", "org-html-head-include-default-style"],
    ["html-head-include-scripts", undefined, "html-scripts", "org-html-head-include-scripts"],
    ["html-allow-name-attribute-in-anchors", undefined, undefined, "org-html-allow-name-attribute-in-anchors"],
    ["html-divs", undefined, undefined, "org-html-divs"],
    ["html-checkbox-type", undefined, undefined, "org-html-checkbox-type"],
    ["html-extension", undefined, undefined, "org-html-extension"],
    ["html-footnote-format", undefined, undefined, "org-html-footnote-format"],
    ["html-footnote-separator", undefined, undefined, "org-html-footnote-separator"],
    ["html-footnotes-section", undefined, undefined, "org-html-footnotes-section"],
    ["html-format-drawer-function", undefined, undefined, () => e8.variable("org-html-format-drawer-function")],
    ["html-format-headline-function", undefined, undefined, () => e8.variable("org-html-format-headline-function")],
    ["html-format-inlinetask-function", undefined, undefined, () => e8.variable("org-html-format-inlinetask-function")],
    ["html-home/up-format", undefined, undefined, "org-html-home/up-format"],
    ["html-indent", undefined, undefined, "org-html-indent"],
    ["html-infojs-options", undefined, undefined, "org-html-infojs-options"],
    ["html-infojs-template", undefined, undefined, "org-html-infojs-template"],
    ["html-inline-image-rules", undefined, undefined, "org-html-inline-image-rules"],
    ["html-link-org-files-as-html", undefined, undefined, "org-html-link-org-files-as-html"],
    ["html-mathjax-options", undefined, undefined, "org-html-mathjax-options"],
    ["html-mathjax-template", undefined, undefined, "org-html-mathjax-template"],
    ["html-metadata-timestamp-format", undefined, undefined, "org-html-metadata-timestamp-format"],
    ["html-postamble-format", undefined, undefined, "org-html-postamble-format"],
    ["html-preamble-format", undefined, undefined, "org-html-preamble-format"],
    ["html-prefer-user-labels", undefined, undefined, "org-html-prefer-user-labels"],
    ["html-self-link-headlines", undefined, undefined, "org-html-self-link-headlines"],
    ["html-table-align-individual-fields", undefined, undefined, "org-html-table-align-individual-fields"],
    ["html-table-caption-above", undefined, undefined, "org-html-table-caption-above"],
    ["html-table-data-tags", undefined, undefined, "org-html-table-data-tags"],
    ["html-table-header-tags", undefined, undefined, "org-html-table-header-tags"],
    ["html-table-use-header-tags-for-first-column", undefined, undefined, "org-html-table-use-header-tags-for-first-column"],
    ["html-tag-class-prefix", undefined, undefined, "org-html-tag-class-prefix"],
    ["html-text-markup-alist", undefined, undefined, "org-html-text-markup-alist"],
    ["html-todo-kwd-class-prefix", undefined, undefined, "org-html-todo-kwd-class-prefix"],
    ["html-toplevel-hlevel", undefined, undefined, "org-html-toplevel-hlevel"],
    ["html-use-infojs", undefined, undefined, "org-html-use-infojs"],
    ["html-validation-link", undefined, undefined, "org-html-validation-link"],
    ["html-viewport", undefined, undefined, "org-html-viewport"],
    ["html-inline-images", undefined, undefined, "org-html-inline-images"],
    ["html-table-attributes", undefined, undefined, "org-html-table-default-attributes"],
    ["html-table-row-open-tag", undefined, undefined, "org-html-table-row-open-tag"],
    ["html-table-row-close-tag", undefined, undefined, "org-html-table-row-close-tag"],
    ["html-xml-declaration", undefined, undefined, "org-html-xml-declaration"],
    ["html-wrap-src-lines", undefined, undefined, "org-html-wrap-src-lines"],
    ["html-klipsify-src", undefined, undefined, "org-html-klipsify-src"],
    ["html-klipse-css", undefined, undefined, "org-html-klipse-css"],
    ["html-klipse-js", undefined, undefined, "org-html-klipse-js"],
    ["html-klipse-selection-script", undefined, undefined, "org-html-klipse-selection-script"],
    ["infojs-opt", "INFOJS_OPT", undefined, undefined],
    ["creator", "CREATOR", undefined, "org-html-creator-string"],
    ["with-latex", undefined, "tex", "org-html-with-latex"],
    ["latex-header", "LATEX_HEADER", undefined, undefined, "newline"],
  ],
});

// --- Commands -------------------------------------------------------------------------

e8.defineCommand({
  name: "org-html-export-as-html",
  doc: "Export current buffer to an HTML buffer, *Org HTML Export*.\n\nWith SUBTREEP, export the subtree at point; with VISIBLE-ONLY, only visible text; with BODY-ONLY, only the body, without the <head> and <body> tags.",
  params: EXPORT_PARAMS,
  run: (a, s, v, b, e) => {
    exportAsHtml(a, s, v, b, e);
  },
});

e8.defineCommand({
  name: "org-html-export-to-html",
  doc: "Export current buffer to an HTML file, named after the buffer's file with org-html-extension; return its name.",
  params: EXPORT_PARAMS,
  run: (a, s, v, b, e) => {
    exportToHtml(a, s, v, b, e);
  },
});

e8.defun("org-html-htmlize-region-for-paste", (beg: number, end: number) => htmlizeRegionForPaste(beg, end));

e8.defineCommand({
  name: "org-html-htmlize-generate-css",
  doc:
    "Create the CSS for all font definitions in the current Emacs session.\n\n" +
    "The *html* buffer then holds a class for each face, its name prefixed with org-html-htmlize-font-prefix, to copy into a style sheet; " +
    "with org-html-htmlize-output-type css, source blocks are exported with these classes.",
  run: () => {
    const old = e8.getBuffer("*html*");
    if (old) e8.call("kill-buffer", "*html*");
    const temp = e8.generateNewBufferName(" *Org HTML htmlize CSS*");
    e8.getBufferCreate(temp);
    let html: string;
    try {
      html = e8.withCurrentBuffer(temp, () =>
        e8.letBind({ "htmlize-css-name-prefix": e8.variable("org-html-htmlize-font-prefix") ?? "", "htmlize-output-type": e8.intern("css") }, () => {
          for (const face of e8.faceList()) {
            const inherit = e8.faceAttribute(face, ":inherit");
            if (Array.isArray(inherit) && inherit.length > 0) continue;
            const at = e8.point();
            e8.insert("1");
            e8.putTextProperty(at, at + 1, "face", face);
          }
          return htmlizeRegion(e8.pointMin(), e8.pointMax(), { fontified: true });
        }),
      );
    } finally {
      e8.call("kill-buffer", temp);
    }
    e8.call("pop-to-buffer-same-window", html);
    // Only the style sheet, as Org leaves it: from <style to the line after </style>, that line's indentation gone.
    const text = e8.bufferText();
    const start = text.indexOf("<style");
    const close = text.indexOf("</style>", Math.max(start, 0));
    if (start >= 0 && close >= 0) {
      const kept = text.slice(start, close + "</style>".length + 1);
      eraseBuffer();
      e8.insert(kept.replace(/\n +(<\/style>\n?)$/, "\n$1"));
    }
    e8.gotoChar(e8.pointMin());
  },
});

e8.defineCommand({
  name: "org-html-convert-region-to-html",
  doc: "Assume the current region has Org syntax, and convert it to HTML.",
  run: () => replaceRegionBy("html"),
});

/** Publish an Org file to HTML, as org-html-publish-to-html; returns the file written. */
e8.defun("org-html-publish-to-html", (plist: e8.Value[], filename: string, pubDir: string) => {
  const variable = varValue("org-html-extension");
  const htmlExt = typeof variable === "string" ? variable : "";
  // An empty org-html-extension is not nil, so it is the extension, as in Lisp's or.
  const ext = plistGet(plist, ":html-extension") ?? (typeof variable === "string" ? variable : "html");
  return publishOrgTo("html", filename, (htmlExt.length > 0 ? "." : "") + ext, plist, pubDir);
});
