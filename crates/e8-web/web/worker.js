// The editor's thread: instantiates the module the page loaded, sharing its
// memory, and runs the body e8-web's spawn_worker passed, which never
// returns. Its messages to the page only ask for a repaint.
// Rust panics print their stack; ten frames rarely reach the cause.
Error.stackTraceLimit = 64;

import init, { worker_start } from "./pkg/e8_web.js";

self.onmessage = async (event) => {
  const [module, memory, body, stack] = event.data;
  self.onmessage = null;
  await init({ module_or_path: module, memory, thread_stack_size: stack });
  worker_start(body);
};
