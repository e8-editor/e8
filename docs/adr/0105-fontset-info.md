# 0105. fontset-info

Status: accepted · 2026-11-15

## Context

fontset.c's `fontset-info` was the last platform primitive E8 lacked but CCL's. It describes a fontset as a char-table: each character's value lists the fonts it is given, each with the fonts actually opened for it, `((FONT OPENED-FONT ...) ...)`. The extra slot of a fontset other than the default holds the same for the default fontset. `describe-fontset` and `list-fontsets` (mule-diag.el) are written on it.

E8 keeps fontsets as fontset.c does ([ADR 0085](0085-face-and-font-internals-as-emacs-has-them.md)), but its front ends do not draw with them, so no font is ever opened for one.

## Decision

`Editor::fontset_info` builds the char-table, of subtype `fontset-info` with one extra slot, from the fontset's entries:

- **Ranges.** A range gives its characters.
- **Scripts.** A script gives its characters' ranges from `char-script-table`'s data.
- **Charsets.** A charset gives the ranges its codes hold.
- **The default entry** is the table's default.

Earlier entries win, as the fontset's own lookup takes them. Each font's list holds the font alone, as none is opened. A fontset other than the default gets the default fontset's table in its extra slot. Without a window system it signals as Emacs's does in batch.

## Consequences

- **What it unblocks.** `describe-fontset` and `list-fontsets` can be ported.
- **Recorded in [differences.md](../differences.md):** no opened fonts are listed.
- **Left of the C core's platform primitives:** CCL alone.
