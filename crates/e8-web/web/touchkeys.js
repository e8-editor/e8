// On a touch screen, the keys a phone's keyboard lacks, as Termux has them:
// a row under the editor with Esc, Ctrl, Alt, Tab and the arrows, and a
// button that brings the phone's keyboard up or puts it away. The keyboard
// types into a text field of the page's own, hidden in the editor, as egui's
// would come up only for text egui edits: what the field takes goes to E8 as
// keys, and the field is emptied again. Desktops, whose main pointer is not
// a finger, get none of this.
//
// Ctrl and Alt work as Shift does on a phone: a tap applies it to the next
// key, a second tap at once keeps it on, and a tap then turns it off.

/// Whether this is a touch screen: its main pointer a finger. iPads say
/// they are Macs, so this asks what the screen can do rather than its name.
export function isTouch() {
  return matchMedia("(pointer: coarse)").matches;
}

/// Lets the canvas hear a finger only as touch events. Browsers send a
/// finger as touches and as pointer events, and egui makes a press of each,
/// sometimes in different frames, so a tap counted as a double click;
/// e8-web turns the touches into scrolling and clicks itself. A mouse's
/// pointer events, and those on the page's own buttons, are left alone.
export function fingersAsTouches(canvas) {
  for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
    window.addEventListener(type, (event) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen" && event.target === canvas) event.stopImmediatePropagation();
    }, { capture: true });
  }
}

// What the field holds between keys, so that Backspace has something to
// delete, and with nothing deleted no event comes.
const BASE = "  ";
const REPEAT_DELAY = 400;
const REPEAT_EVERY = 60;
const LOCK_WITHIN = 350;

// A keyboard, drawn, as fonts often lack ⌨.
const KEYBOARD = `<svg width="22" height="16" viewBox="0 0 22 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
<rect x="1" y="1" width="20" height="14" rx="2.5"/><path d="M5 5h1M9 5h1M13 5h1M17 5h0.5M5 8.5h1M9 8.5h1M13 8.5h1M17 8.5h0.5M7 12h8" stroke-linecap="round"/></svg>`;

const STYLE = `
.e8-touch { display: flex; flex-direction: column; }
.e8-touch > canvas { flex: 1 1 auto; min-height: 0; height: auto !important; }
.e8-touch-field { position: absolute; top: 0; left: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0;
  resize: none; overflow: hidden; font-size: 16px; caret-color: transparent; pointer-events: none; }
.e8-keys { flex: none; display: flex; gap: 4px; padding: 4px; background: var(--bg, #f4f1ea);
  border-top: 1px solid var(--line, #d8d3c8); touch-action: manipulation; user-select: none; -webkit-user-select: none; }
.e8-keys button { flex: 1 1 0; min-width: 0; height: 38px; padding: 0; border: 1px solid var(--line, #d8d3c8);
  border-radius: 6px; background: none; color: var(--ink, #1d1c1a); font: 13px/1 var(--mono, ui-monospace, monospace);
  -webkit-tap-highlight-color: transparent; display: grid; place-items: center; }
.e8-keys button.on { background: var(--ink, #1d1c1a); color: var(--bg, #f4f1ea); }
.e8-keys button.locked { box-shadow: inset 0 -3px 0 var(--sun, #f2541b); }
`;

/// Puts the keys under `canvas`, in `editor`, the element that holds it.
/// `e8` is the module's exports: `send_key`, `send_text` and `set_typing`.
/// `beforeKeyboard` runs before the keyboard comes up, as the website goes
/// to full window then.
export function install(editor, canvas, e8, { beforeKeyboard } = {}) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  editor.classList.add("e8-touch");

  const field = document.createElement("textarea");
  field.className = "e8-touch-field";
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("autocomplete", "off");
  field.setAttribute("autocorrect", "off");
  field.setAttribute("spellcheck", "false");
  field.setAttribute("aria-label", "Type into E8");
  field.tabIndex = -1;
  editor.append(field);

  // Ctrl and Alt: off, on for the next key ("once") or kept on ("locked").
  const mods = { ctrl: "off", meta: "off" };
  const buttons = {};
  let lastTap = { ctrl: 0, meta: 0 };
  function paint() {
    for (const m of ["ctrl", "meta"]) {
      buttons[m].classList.toggle("on", mods[m] !== "off");
      buttons[m].classList.toggle("locked", mods[m] === "locked");
    }
  }
  // Sends a key with Ctrl and Alt as the buttons and the event say, and
  // lets go of those on for one key.
  function key(name, ctrl = false, meta = false) {
    e8.send_key(name, ctrl || mods.ctrl !== "off", meta || mods.meta !== "off");
    let changed = false;
    for (const m of ["ctrl", "meta"]) {
      if (mods[m] === "once") {
        mods[m] = "off";
        changed = true;
      }
    }
    if (changed) paint();
  }
  // Text from the keyboard: its first character takes Ctrl or Alt if one is on.
  function text(s) {
    if (!s) return;
    if (mods.ctrl !== "off" || mods.meta !== "off") {
      const [first, ...rest] = s;
      key(first === "\n" ? "Enter" : first);
      s = rest.join("");
    }
    if (s) e8.send_text(s);
  }

  // What the keyboard typed is what the field gained or lost since the last
  // look. While a word is being composed (Android's keyboards compose every
  // word) the field keeps it, and corrections arrive as deletions and text.
  let last = BASE;
  let composing = false;
  function reset() {
    field.value = BASE;
    field.setSelectionRange(BASE.length, BASE.length);
    last = BASE;
  }
  function sync() {
    const now = field.value;
    let same = 0;
    while (same < last.length && same < now.length && last[same] === now[same]) same++;
    for (let n = last.length - same; n > 0; n--) key("Backspace");
    text(now.slice(same));
    last = now;
    if (!composing) reset();
  }
  field.addEventListener("input", sync);
  field.addEventListener("compositionstart", () => (composing = true));
  field.addEventListener("compositionend", () => {
    composing = false;
    setTimeout(sync);
  });
  // A keyboard's keys: chords and keys that type nothing go to E8 as keys,
  // the rest as text through the field. Cmd is left to the system.
  field.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229 || event.metaKey) return;
    const named = /^(Escape|Tab|Arrow\w+|Home|End|Page\w+|Delete)$/.test(event.key);
    const chord = event.ctrlKey || event.altKey;
    if (!named && !chord) return;
    event.preventDefault();
    let name = event.key;
    // Option on Apple's keyboards types a character of its own (≈ for x).
    if (event.altKey && /^Key[A-Z]$/.test(event.code)) {
      name = event.shiftKey ? event.code[3] : event.code[3].toLowerCase();
    } else if (event.altKey && /^Digit\d$/.test(event.code)) {
      name = event.code[5];
    }
    key(name, event.ctrlKey, event.altKey);
  });

  // The keyboard is wanted from the button until the button puts it away or
  // the system does. A tap in the text gives the canvas the focus, and the
  // field takes it back in the same tap, so the keyboard stays.
  let wanted = false;
  let touching = false;
  field.addEventListener("focus", () => {
    reset();
    e8.set_typing(true);
    buttons.keyboard.classList.add("on");
  });
  field.addEventListener("blur", () => {
    e8.set_typing(false);
    buttons.keyboard.classList.remove("on");
    if (!touching) wanted = false;
  });
  canvas.addEventListener("touchstart", () => (touching = true), { passive: true });
  canvas.addEventListener("touchend", () => {
    touching = false;
    if (wanted && document.activeElement !== field) field.focus({ preventScroll: true });
  });
  canvas.addEventListener("touchcancel", () => (touching = false));
  function keyboard() {
    if (document.activeElement === field) {
      wanted = false;
      field.blur();
      canvas.focus({ preventScroll: true });
    } else {
      beforeKeyboard?.();
      wanted = true;
      field.focus({ preventScroll: true });
    }
  }

  const bar = document.createElement("div");
  bar.className = "e8-keys";
  const keys = [
    ["Esc", "Escape"],
    ["Ctrl", "ctrl"],
    ["Alt", "meta"],
    ["Tab", "Tab"],
    ["←", "ArrowLeft"],
    ["↓", "ArrowDown"],
    ["↑", "ArrowUp"],
    ["→", "ArrowRight"],
    [KEYBOARD, "keyboard"],
  ];
  for (const [label, name] of keys) {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    if (label.startsWith("<svg")) button.innerHTML = label;
    else button.textContent = label;
    button.setAttribute("aria-label", { Escape: "Escape", ctrl: "Control", meta: "Alt (Meta)", keyboard: "Show or hide the keyboard" }[name] ?? label);
    buttons[name] = button;
    bar.append(button);
    // A press must not take the focus from the field, or the keyboard goes.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    if (name === "keyboard") {
      // Focusing the field brings the keyboard up only within a tap.
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", keyboard);
    } else if (name === "ctrl" || name === "meta") {
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        const now = performance.now();
        mods[name] = mods[name] === "off" ? "once" : mods[name] === "once" && now - lastTap[name] < LOCK_WITHIN ? "locked" : "off";
        lastTap[name] = now;
        paint();
      });
    } else {
      // Held, a key repeats, as a keyboard's does.
      let timer;
      const stop = () => clearTimeout(timer);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        key(name);
        const again = (delay) => (timer = setTimeout(() => (key(name), again(REPEAT_EVERY)), delay));
        if (name.startsWith("Arrow")) again(REPEAT_DELAY);
      });
      for (const end of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(end, stop);
    }
  }
  editor.append(bar);
  paint();

  // Where the keyboard leaves room: the visual viewport, which the page's
  // CSS reads as --e8-view-top and --e8-view-height to keep the editor and
  // its keys above the keyboard.
  const view = window.visualViewport;
  if (view) {
    const place = () => {
      document.documentElement.style.setProperty("--e8-view-top", `${view.offsetTop}px`);
      document.documentElement.style.setProperty("--e8-view-height", `${view.height}px`);
    };
    view.addEventListener("resize", place);
    view.addEventListener("scroll", place);
    place();
  }
}
