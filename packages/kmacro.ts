// Keyboard macros: F3, F4, C-x ( and C-x ), after Emacs's kmacro.el.
//
// Recording and replaying keys are editor primitives; this package provides
// the commands and the macro counter.

/** The counter F3 inserts while a macro is defined or run (Emacs's kmacro-counter). */
let counter = 0;
/** The counter before its last increment, which C-u F3 inserts (Emacs's kmacro-last-counter). */
let lastCounter = 0;

e8.defineVariable({
  name: "kmacro-execute-before-append",
  doc: "Whether C-u C-x ( runs the last macro before appending to it, and C-u C-u C-x ( does not; nil turns these round.",
  value: true,
});

function startMacro(): void {
  if (e8.definingKbdMacro() || e8.executingKbdMacro()) {
    // Emacs only says so; it is not an error.
    e8.message("Already defining keyboard macro.");
    return;
  }
  const arg = e8.prefixArg();
  // C-u appends to the last macro, keeping the counter, as kmacro-start-macro does.
  if (Array.isArray(arg)) {
    const runFirst = e8.variable("kmacro-execute-before-append") !== false;
    e8.startKbdMacro(true, runFirst ? arg[0] > 4 : arg[0] === 4);
    e8.message("Appending to kbd macro...");
    return;
  }
  e8.startKbdMacro();
  counter = arg === null ? 0 : e8.prefixNumericValue(arg);
  lastCounter = counter;
  e8.message("Defining kbd macro...");
}

function endMacro(): void {
  e8.endKbdMacro();
  e8.message("Keyboard macro defined");
}

function insertCounter(): void {
  // C-u inserts the value before the last increment, and adds nothing.
  if (Array.isArray(e8.prefixArg())) {
    e8.insert(String(lastCounter));
    return;
  }
  e8.insert(String(counter));
  lastCounter = counter;
  counter += e8.prefixNumericValue();
}

e8.defineCommand({
  name: "kmacro-start-macro",
  doc:
    "Start recording a keyboard macro: the keys typed until C-x ) or F4.\n\n" +
    "A numeric prefix argument sets the macro counter's starting value, which is 0 otherwise; C-u appends to the last macro, " +
    "running it first, and C-u C-u appends without running it.",
  run: startMacro,
});

e8.defineCommand({
  name: "kmacro-end-macro",
  doc: "Finish recording the keyboard macro.",
  run: endMacro,
});

e8.defineCommand({
  name: "kmacro-insert-counter",
  doc: "Insert the macro counter, then add the prefix argument to it, 1 by default.",
  run: insertCounter,
});

e8.defineCommand({
  name: "kmacro-start-macro-or-insert-counter",
  doc:
    "Start recording a keyboard macro, or insert the macro counter if one is being recorded or run.\n\n" +
    "So F3 starts a macro, and F3 inside it inserts 0, 1, 2 and so on each time the macro runs.",
  run: () => {
    if (e8.definingKbdMacro() || e8.executingKbdMacro()) {
      insertCounter();
    } else {
      startMacro();
    }
  },
});

e8.defineCommand({
  name: "kmacro-call-macro",
  doc:
    "Run the last keyboard macro, as many times as the prefix argument says.\n\n" +
    "An argument of 0 repeats it until it fails. The first error stops it.",
  run: () => e8.callLastKbdMacro(e8.prefixNumericValue()),
});

e8.defineCommand({
  name: "kmacro-end-or-call-macro",
  doc: "Finish recording the keyboard macro, or run the last one if none is being recorded.",
  run: () => {
    if (e8.definingKbdMacro()) {
      endMacro();
    } else {
      e8.callLastKbdMacro(e8.prefixNumericValue());
    }
  },
});

e8.defineCommand({
  name: "kmacro-end-and-call-macro",
  doc:
    "Finish recording the keyboard macro if one is being recorded, then run it.\n\n" +
    "Typing e again runs it again.",
  run: () => {
    if (e8.definingKbdMacro()) {
      endMacro();
    }
    e8.callLastKbdMacro(e8.prefixNumericValue());
    e8.setTransientMap({ e: "kmacro-end-and-call-macro" });
  },
});

e8.bindKey("<f3>", "kmacro-start-macro-or-insert-counter");
e8.bindKey("<f4>", "kmacro-end-or-call-macro");
e8.bindKey("C-x (", "kmacro-start-macro");
e8.bindKey("C-x )", "kmacro-end-macro");
e8.bindKey("C-x e", "kmacro-end-and-call-macro");
