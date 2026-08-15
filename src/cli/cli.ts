/**
 * Headless drive CLI over the shared DriveEngine. A Node peer with subcommands:
 *
 *   accept-invite <url>  link this device from a device-invite/rendezvous URL, pull
 *                        documents best-effort, then exit
 *   list                 print every accessible document (id, versions, last-modified)
 *   show <docId>         render a document's current version as JSON to stdout
 *   diff <docId> …       print the JSON patch ops between two document versions
 *   sync --forever | --duration <seconds>
 *                        the long-running watch/server loop: keep the N most-recent docs
 *                        open to sync continuously and rotate the rest (open, dwell, close),
 *                        logging a structured line on every observed change.
 *
 * Diagnostics go to stderr; only `list`/`show`/`diff` command output goes to stdout,
 * so `drive-cli show <id> > doc.json` yields clean JSON.
 *
 * Relay use is per-command: `accept-invite` and `sync` open the relay WebSocket;
 * the read commands (`list`/`show`/`diff`) run **local-only** — no relay socket is
 * opened, so they report exactly what is already in the local store.
 *
 * Storage model (see src/shared/keyhive-repo.ts + node-kvstore.ts):
 *   ${dataDir}/secure   NodeFS repo store — automerge docs AND the keyhive device
 *                       identity (so this device is stable across restarts).
 *   ${dataDir}/kv.json   app metadata — the user-group id + doc list.
 *
 * Degraded vs. the browser: no HyperFormula (DataGrid formula recompute in
 * queries) and no WebRTC upgrade (relay-only). Both are fine for a headless peer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { decode as cborDecode, Encoder } from 'cbor-x';
import { NetworkAdapter } from '@automerge/automerge-repo';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import { isRendezvousType } from '../shared/rendezvous-protocol';
import { PRODUCTION_RELAY_URL, isRelayLeaveFrame } from '../shared/relay-identity';
import { parseRendezvousToken } from '../shared/rendezvous-url';
import { DriveEngine, type DriveEngineInstance, type WatchUpdate } from '../shared/drive-engine';
import { relativeTime } from '../shared/relative-time';
import { NodeKVStore } from './node-kvstore';
import { ensureKeyhiveNodeShim, initSubductionNode } from './keyhive-node-shim';
import { KEYS } from '../shared/storage-keys';
import type { EngineHost, EngineNetwork } from '../shared/engine-host';
import type { WorkerToMain } from '../shared/worker-protocol';
import { createLogger } from '../shared/logger';

// The CLI's transcript, not diagnostics: `info` so the default level shows it,
// `error` for the failures. Real command output goes through out() → the stdout
// captured before main() redirects the stream to stderr, so it is never gated.
const log = createLogger('cli');

function intArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected an integer, got "${value}"`);
  return n;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A do-nothing NetworkAdapter for the local-only read commands (list/show/diff).
 * It reports ready immediately and never discovers a peer, so the repo runs purely
 * against local storage and nothing ever dials the relay. We can't pass `undefined`
 * to the keyhive bridge — it wraps whatever adapter it's given and calls `.on()`,
 * `.connect()`, `.isReady()` on it — so this stub satisfies that contract with no I/O.
 */
class OfflineNetworkAdapter extends NetworkAdapter {
  isReady(): boolean { return true; }
  whenReady(): Promise<void> { return Promise.resolve(); }
  connect(): void { /* no peers, ever */ }
  send(): void { /* nothing to send */ }
  disconnect(): void { /* nothing to close */ }
}

// Command output — the only thing written to real stdout. Captured before main()
// redirects process.stdout.write to stderr, so it bypasses that redirect.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const out = (line: string) => realStdoutWrite(line + '\n');

/** A patch path (keys and array indices), slash-separated: `events/uid/title`, `list/3`. */
function fmtPatchPath(path: unknown[]): string {
  return path.length ? path.map(String).join('/') : '(root)';
}

/** One Automerge patch op on a single line: `<action> <path> [= value]`. */
function fmtPatch(op: any): string {
  const path = fmtPatchPath(Array.isArray(op?.path) ? op.path : []);
  const a = String(op?.action ?? '?').padEnd(6);
  switch (op?.action) {
    case 'put':
    case 'splice': return `${a} ${path} = ${JSON.stringify(op.value)}`;
    case 'insert': return `${a} ${path} = ${JSON.stringify(op.values)}`;
    case 'inc':    return `${a} ${path} += ${op.value}`;
    case 'del':    return `${a} ${path}${op.length > 1 ? ` (×${op.length})` : ''}`;
    default: {
      const { action, path: _p, ...rest } = op ?? {};
      const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      return `${a} ${path}${extra}`;
    }
  }
}

/** Wait until the adapter's raw relay socket is OPEN (rendezvous frames are dropped otherwise). */
async function waitForRelayConnection(adapter: any, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sock: any = adapter.socket;
    if (sock && sock.readyState === 1) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the relay connection (${adapter.url ?? ''})`);
}

/**
 * Wait for the relay socket to flush all queued outbound bytes, then a short grace
 * so the relay can forward them to the peer. Without this, exiting right after the
 * device-link handshake sends its final frame races the WebSocket flush — the frame
 * is lost and the *other* device hangs waiting for it (e.g. stuck "Exchanging keys…").
 */
async function drainRelay(adapter: any, graceMs = 1000, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sock: any = adapter.socket;
    if (!sock || sock.bufferedAmount === 0) break;
    await sleep(50);
  }
  await sleep(graceMs);
}

interface CliOpts {
  relay?: string;
  dataDir?: string;
  keepOpen?: number;
  recentDays?: number;
  syncSeconds?: number;
  forever?: boolean;
  duration?: number;
}

/** Every subcommand persists to --data-dir. */
function withDataDir(c: Command): Command {
  // Default is env-aware so `--help` shows the value that will actually be used.
  return c.option('--data-dir <dir>', 'data directory', process.env.AUTOMERGE_DATA_DIR ?? './.data/cli');
}
/** Commands that talk to the relay (accept-invite, sync) also take --relay. */
function withRelay(c: Command): Command {
  return c.option('--relay <url>', 'relay WebSocket URL', process.env.DRIVE_RELAY_URL ?? PRODUCTION_RELAY_URL);
}

/** Resolve the data directory the same way whether or not the engine is started yet. */
function resolveDataDir(opts: CliOpts): string {
  return opts.dataDir ?? process.env.AUTOMERGE_DATA_DIR ?? './.data/cli';
}

/**
 * Build the node EngineHost and initialize the engine. Diagnostics go to stderr
 * so command output on stdout stays clean.
 *
 * `mode.network` selects the transport:
 *   - `true`  (accept-invite, sync): open the relay WebSocket and wire the
 *             rendezvous overlay. `wsAdapter` in the result is that socket.
 *   - `false` (list, show, diff): local-only. No socket is opened; an
 *             OfflineNetworkAdapter stands in so nothing ever dials the relay,
 *             and `wsAdapter` in the result is null.
 */
async function startEngine(
  opts: CliOpts,
  mode: { network: boolean },
): Promise<{ engine: DriveEngineInstance; kv: NodeKVStore; wsAdapter: any }> {
  const dataDir = resolveDataDir(opts);

  // Patch the keyhive slim build + initialize the subduction WASM for Node, both
  // before the bridge is imported / the Repo is created (in engine.init).
  ensureKeyhiveNodeShim();
  await initSubductionNode();

  fs.mkdirSync(dataDir, { recursive: true });
  const secureDir = path.join(dataDir, 'secure');
  fs.mkdirSync(secureDir, { recursive: true });

  const kv = new NodeKVStore(path.join(dataDir, 'kv.json'));
  const storage = new NodeFSStorageAdapter(secureDir);

  let wsAdapter: any = null;
  let network: EngineNetwork;
  if (mode.network) {
    const relayUrl = opts.relay ?? process.env.DRIVE_RELAY_URL ?? PRODUCTION_RELAY_URL;
    log.info(`relay=${relayUrl} data-dir=${dataDir}`);
    wsAdapter = new WebSocketClientAdapter(relayUrl);
    const rdvEncoder = new Encoder({ tagUint8Array: false, useRecords: false });
    let rdvHandler: ((frame: any) => void) | null = null;

    // Intercept rendezvous overlay frames off the raw socket before the repo sees them.
    const origReceive = wsAdapter.receiveMessage.bind(wsAdapter);
    (wsAdapter as any).receiveMessage = (bytes: Uint8Array) => {
      try {
        const decoded = cborDecode(new Uint8Array(bytes));
        if (isRendezvousType(decoded?.type)) { rdvHandler?.(decoded); return; }
        // The relay's departure broadcast — the stock adapter has no such message
        // type, so translate it into the peer-disconnected the repo understands.
        if (isRelayLeaveFrame(decoded)) {
          (wsAdapter as any).emit('peer-disconnected', { peerId: decoded.senderId });
          return;
        }
      } catch { /* not an overlay frame — fall through to the repo adapter */ }
      return origReceive(bytes);
    };

    // Notify the engine on every socket (re)open so it re-sends its RELAY_WATCH
    // declaration — the relay's discovery state is per-socket. The adapter's own
    // onOpen (which sends `join`) runs first, same pattern as the browser worker.
    let socketOpenHandler: (() => void) | null = null;
    const origOnOpen = wsAdapter.onOpen;
    wsAdapter.onOpen = () => { origOnOpen(); socketOpenHandler?.(); };

    network = {
      networkAdapter: wsAdapter,
      sendOverlayFrame: (frame) => {
        // Read the socket lazily: the keyhive integration may re-wrap the adapter,
        // and the socket is (re)created on connect/reconnect.
        const sock: any = (wsAdapter as any).socket;
        if (sock && sock.readyState === 1) sock.send(rdvEncoder.encode(frame));
      },
      onRendezvousFrame: (handler) => { rdvHandler = handler; },
      onSocketOpen: (handler) => { socketOpenHandler = handler; },
    };
  } else {
    // Local-only: no relay socket, no rendezvous overlay. The OfflineNetworkAdapter
    // keeps the keyhive bridge + repo happy while guaranteeing zero network I/O.
    log.info(`local-only data-dir=${dataDir}`);
    network = {
      networkAdapter: new OfflineNetworkAdapter(),
      sendOverlayFrame: () => { /* no relay in local-only mode */ },
      onRendezvousFrame: () => { /* no relay in local-only mode */ },
    };
  }

  const emit = (event: WorkerToMain): void => {
    // Log every emitted engine event to stderr. A few get a friendlier one-line
    // summary; the rest fall through to a generic dump so nothing is dropped.
    switch (event.type) {
      case 'ready': log.info(`ready, peerId=${event.peerId}`); return;
      case 'kh-ready': log.info('keyhive ready'); return;
      case 'kh-error': log.error('keyhive error:', event.message); return;
      case 'error': log.error('error:', event.message); return;
      case 'data-warning': log.warn('warning:', event.message); return;
      case 'peer-connected':
      case 'peer-disconnected': log.info(`peers: ${event.peerCount}`); return;
      case 'doc-list-updated': log.info(`doc list: ${event.list.length} doc(s)`); return;
      case 'kh-rdv-event':
        log.info(`link ${event.status}${event.message ? `: ${event.message}` : ''}`); return;
      default: log.info(`event ${event.type}`, event); return;
    }
  };

  const host: EngineHost = { storage, kv, network, emit };
  const engine = new DriveEngine(host);
  await engine.init();
  return { engine, kv, wsAdapter };
}

/** Exit with a hint unless this device already has a linked identity. */
async function requireLinked(kv: NodeKVStore): Promise<void> {
  if (await kv.get<string>(KEYS.userGroupId)) return;
  log.error('no stored identity — link this device first:');
  log.error('  npm run cli -- accept-invite "https://…/#/link-device/r.<id>.<key>"');
  process.exit(1);
}

/** Reject after `ms` — opening a doc blocks on whenReady() (it may still be syncing). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(message)))]);
}

/** Poll (up to ~20s) for the keyhive group graph to sync so accessible docs surface. */
async function waitForDocs(engine: DriveEngineInstance): Promise<string[]> {
  log.info('waiting for documents to sync…');
  let ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    ids = await engine.enumerateAccessibleDocIds();
    if (ids.length) break;
    await sleep(1000);
  }
  return ids;
}

async function main(): Promise<void> {
  // All diagnostics — ours, the engine's, and keyhive's — go to stderr; only
  // explicit command output (via `out`) reaches real stdout, so a redirect like
  // `show <id> > doc.json` yields clean JSON. Redirecting the stream's write
  // (not console.log) also catches libraries that bound console.log at import.
  process.stdout.write = ((chunk: any, enc?: any, cb?: any) =>
    (process.stderr.write as any)(chunk, enc, cb)) as typeof process.stdout.write;

  const program = new Command();
  program
    .name('drive-cli')
    .description('Headless drive peer over the shared DriveEngine.')
    .showHelpAfterError();

  // ── accept-invite: link this device, pull docs best-effort, then exit ───────
  withRelay(withDataDir(program.command('accept-invite <url>')))
    .description('link this device from a device-invite/rendezvous URL, pull documents, then exit')
    .action(async (url: string, opts: CliOpts) => {
      const parsed = parseRendezvousToken(url);
      if (!parsed) {
        log.error('could not parse an invite from the given URL/token (expected …/link-device/r.<id>.<key>).');
        process.exit(1);
      }
      const { engine, wsAdapter } = await startEngine(opts, { network: true });
      // Rendezvous frames ride the raw relay socket — it must be OPEN before we
      // subscribe, or the RDV_SUB is dropped and the other device waits forever.
      log.info('connecting to relay…');
      await waitForRelayConnection(wsAdapter, 20_000);
      log.info('linking device via rendezvous…');
      await engine.rendezvousLinkJoin(parsed.rendezvousId, parsed.key);
      // Flush the return handshake frame before we do anything else, or the other
      // device hangs (stuck "Exchanging keys…") waiting for a frame we never flushed.
      await drainRelay(wsAdapter);
      // Pull best-effort: wait for the keyhive group graph to arrive so the doc list
      // surfaces. Sync completion isn't observable in this stack (there's no
      // "caught up" signal), so we can't guarantee every doc's content has landed —
      // hence the run-`sync` hint below.
      log.info('device linked; pulling documents…');
      const ids = await waitForDocs(engine);
      log.info(`device linked; ${ids.length} document(s) visible so far.`);
      log.info("sync is not instantaneous — run 'npm run cli -- sync --forever' (or --duration <seconds>) to pull everything.");
      process.exit(0);
    });

  // ── list: print every accessible document (local only), then exit ───────────
  withDataDir(program.command('list'))
    .description('print every accessible document (id, versions, last-modified) from the local store, then exit')
    .action(async (opts: CliOpts) => {
      const { engine, kv } = await startEngine(opts, { network: false });
      await requireLinked(kv);
      // Local-only: enumerate whatever keyhive access this device already knows
      // about. There's no relay, so there is nothing to wait for.
      const ids = await engine.enumerateAccessibleDocIds();
      log.info(`${ids.length} accessible document(s) (local).`);
      const metas = await Promise.all(ids.map(async (id) => {
        // A doc can be accessible per keyhive yet not present in this device's local
        // store (never synced here). Don't let one such doc reject the whole list.
        try { return await withTimeout(engine.getDocMeta(id), 8_000, 'not local'); }
        catch { return { docId: id, notLocal: true } as any; }
      }));
      // Most-recently-updated first (docs with no known time sort last).
      metas.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
      for (const meta of metas) {
        if (meta.notLocal) { out(`${meta.docId}  (not synced locally)`); continue; }
        const at = meta.lastModified ? relativeTime(new Date(meta.lastModified * 1000)) : 'unknown';
        const parts = [meta.docId];
        if (meta.docType) parts.push(`type=${meta.docType}`);
        if (meta.name) parts.push(`name=${JSON.stringify(meta.name)}`);
        parts.push(`versions=${meta.versions ?? 0}`, `updated=${at}`);
        out(parts.join('  '));
      }
      process.exit(0);
    });

  // ── show: render a document version as JSON (local only), then exit ─────────
  withDataDir(program.command('show'))
    .argument('<docId>', 'document id')
    .argument('[version]', 'history index to render (0-based; default: current version)', intArg)
    .description('render a document version from the local store as JSON to stdout, then exit')
    .action(async (docId: string, version: number | undefined, opts: CliOpts) => {
      const { engine, kv } = await startEngine(opts, { network: false });
      await requireLinked(kv);
      log.info(`loading document${version === undefined ? '' : ` @ v${version}`}…`);
      let doc: any;
      try {
        doc = await withTimeout(engine.getDocJson(docId, version), 30_000,
          'timed out loading the document from the local store');
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      if (doc == null) {
        log.error('document not found in the local store (run `sync` to pull it first).');
        process.exit(1);
      }
      out(JSON.stringify(doc, null, 2));
      process.exit(0);
    });

  // ── diff: Automerge patch ops between two versions (local only), then exit ──
  withDataDir(program.command('diff'))
    .argument('<docId>', 'document id')
    .argument('[from]', 'from history index (0-based; -1 = empty doc; default: to - 1)', intArg)
    .argument('[to]', 'to history index (0-based; default: latest version)', intArg)
    .description('print the JSON patch ops between two document versions (local store) to stdout, then exit')
    .action(async (docId: string, from: number | undefined, to: number | undefined, opts: CliOpts) => {
      const { engine, kv } = await startEngine(opts, { network: false });
      await requireLinked(kv);
      log.info('loading document…');
      let result: { from: number; to: number; patches: any[] };
      try {
        result = await withTimeout(engine.diffVersions(docId, from, to), 30_000,
          'timed out loading the document from the local store');
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log.info(`diff v${result.from} → v${result.to} (${result.patches.length} op(s))`);
      for (const op of result.patches) out(fmtPatch(op));
      process.exit(0);
    });

  // ── sync: the long-running watch/server loop ────────────────────────────────
  // A run mode is REQUIRED: `--forever` (until interrupted) or `--duration <seconds>`
  // (sync a fixed time, then disconnect). Sync completion isn't observable in this
  // stack, so there's no "run until caught up" — you pick indefinite or a time box.
  withRelay(withDataDir(program.command('sync')))
    .description('keep the N most-recent docs open and rotate the rest, syncing continuously')
    .option('--forever', 'run until interrupted (Ctrl-C / SIGTERM). Env: DRIVE_SYNC_FOREVER')
    .option('--duration <seconds>', 'sync for this many seconds, then disconnect and exit. Env: DRIVE_SYNC_DURATION', intArg)
    .option('--keep-open <n>', 'minimum number of most-recently-updated docs to keep open', intArg,
      process.env.DRIVE_KEEP_OPEN ? intArg(process.env.DRIVE_KEEP_OPEN) : 10)
    .option('--recent-days <days>', 'also keep open every doc edited within this many days', intArg,
      process.env.DRIVE_RECENT_DAYS ? intArg(process.env.DRIVE_RECENT_DAYS) : 30)
    .option('--sync-seconds <seconds>', 'seconds to hold each rotated doc open so it can sync', intArg,
      process.env.DRIVE_SYNC_SECONDS ? intArg(process.env.DRIVE_SYNC_SECONDS) : 120)
    .action(async (opts: CliOpts) => {
      // Resolve the run mode (CLI flag → env fallback). Exactly one is required.
      const forever = opts.forever || (process.env.DRIVE_SYNC_FOREVER ? true : false);
      const duration = opts.duration ??
        (process.env.DRIVE_SYNC_DURATION ? intArg(process.env.DRIVE_SYNC_DURATION) : undefined);
      if (forever && duration !== undefined) {
        log.error('choose --forever or --duration, not both.');
        process.exit(1);
      }
      if (!forever && duration === undefined) {
        log.error('sync requires a run mode:');
        log.error('  --forever            run until Ctrl-C / SIGTERM');
        log.error('  --duration <seconds> sync for a fixed time, then disconnect and exit');
        process.exit(1);
      }

      const { keepOpen = 10, recentDays = 30, syncSeconds = 120 } = opts;

      // Verify this device is linked BEFORE startEngine writes anything (kv.json,
      // keyhive archive, repo storage). Reading kv.json does not create files.
      await requireLinked(new NodeKVStore(path.join(resolveDataDir(opts), 'kv.json')));

      const { engine } = await startEngine(opts, { network: true });
      const ids = await waitForDocs(engine);
      log.info(`${ids.length} accessible document(s).`);

      const onUpdate = (u: WatchUpdate): void => {
        const at = u.lastModified ? new Date(u.lastModified * 1000).toISOString() : 'unknown';
        log.info(`update ${u.docId} type=${u.docType ?? '?'} name=${JSON.stringify(u.name ?? '')} versions=${u.versions ?? 0} at=${at}`);
      };
      await engine.startWatching({ keepOpen, recentDays, syncMs: syncSeconds * 1000 }, onUpdate);

      let shuttingDown = false;
      const shutdown = (reason: string, code = 0): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`${reason}`);
        engine.stopWatching();
        process.exit(code);
      };
      process.on('SIGINT', () => shutdown('shutting down…'));
      process.on('SIGTERM', () => shutdown('shutting down…'));

      const knobs = `keep-open=${keepOpen}, recent-days=${recentDays}, sync=${syncSeconds}s`;
      if (duration !== undefined) {
        log.info(`syncing for ${duration}s (${knobs}).`);
        setTimeout(() => shutdown('duration elapsed — disconnecting.'), duration * 1000);
      } else {
        log.info(`syncing forever (${knobs}). Ctrl-C to stop.`);
      }
    });

  // No subcommand → print help to stderr and exit non-zero (there is no default).
  program.action(() => {
    program.outputHelp({ error: true });
    process.exit(1);
  });

  await program.parseAsync();
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
