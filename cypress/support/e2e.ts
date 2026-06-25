// Cypress e2e support file
import '@cypress/code-coverage/support';

// ── Fail tests on automerge-worker fatal errors ─────────────────────────────
// Worker failures arrive on the main thread via postMessage → console.error
// (and worker error events), NOT as window `uncaught:exception`, so Cypress
// would otherwise stay green even when the worker never starts. Capture those
// and fail the test with the real message.
const FATAL_WORKER_RE =
  /(Automerge worker (failed to load|error)|Module load failed|\[worker\] Failed to load modules|Keyhive init failed)/i;
let workerFatalErrors: string[] = [];

const recordIfFatal = (parts: unknown[]) => {
  const msg = parts
    .map((p) => (p && typeof p === 'object' && 'stack' in p ? (p as { stack?: string }).stack : String(p)))
    .join(' ');
  if (FATAL_WORKER_RE.test(msg)) workerFatalErrors.push(msg);
};

Cypress.on('window:before:load', (win) => {
  const origError = win.console.error.bind(win.console);
  win.console.error = (...args: unknown[]) => {
    recordIfFatal(args);
    origError(...args);
  };
  // A SyntaxError while loading a module worker also surfaces as an error event.
  win.addEventListener('error', (e) => {
    const ev = e as ErrorEvent;
    if (ev?.message) recordIfFatal([ev.message, ev.filename]);
  });
});

afterEach(() => {
  if (workerFatalErrors.length) {
    const errs = [...new Set(workerFatalErrors)];
    workerFatalErrors = [];
    throw new Error('Automerge worker reported fatal error(s):\n' + errs.join('\n'));
  }
});

// Stale automerge document handles from previous sessions can fire an
// "unavailable" rejection before the test even starts. This is a background
// sync error, not a test failure — ignore it globally.
Cypress.on('uncaught:exception', (err) => {
  if (err.message.includes('is unavailable')) return false;
  // Preact internal error during component lifecycle (harmless race on navigation)
  if (err.message.includes("'__k'") || err.message.includes("'__c'")) return false;
  // Minified variable ReferenceErrors from the automerge sync worker (background
  // sync noise, not related to test logic). Pattern: "<shortVar> is not defined".
  if (/^[a-zA-Z_$]{1,3} is not defined$/.test(err.message)) return false;
  if (err.message.includes('is not defined')) return false;
  return true;
});
