/**
 * Headless drive CLI over the shared DriveEngine. A Node peer with subcommands:
 *
 *   accept-invite <url>  link this device from a device-invite/rendezvous URL, then exit
 *   list                 print every accessible document (id, versions, last-modified)
 *   show <docId>         render a document's current version as JSON to stdout
 *   sync                 the long-running watch/server loop: keep the N most-recent docs
 *                        open to sync continuously and rotate the rest (open, dwell, close),
 *                        logging a structured line on every observed change.
 *
 * Diagnostics go to stderr; only `list`/`show` command output goes to stdout, so
 * `drive-cli show <id> > doc.json` yields clean JSON.
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
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import { isRendezvousType } from '../shared/rendezvous-protocol';
import { PRODUCTION_RELAY_URL } from '../shared/relay-identity';
import { parseRendezvousToken } from '../shared/rendezvous-url';
import { DriveEngine, type WatchUpdate } from '../shared/drive-engine';
import { NodeKVStore } from './node-kvstore';
import { ensureKeyhiveNodeShim, initSubductionNode } from './keyhive-node-shim';
import { KEYS } from '../shared/storage-keys';
import type { EngineHost, EngineNetwork } from '../shared/engine-host';
import type { WorkerToMain } from '../shared/worker-protocol';

function intArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected an integer, got "${value}"`);
  return n;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Command output — the only thing written to real stdout. Captured before main()
// redirects process.stdout.write to stderr, so it bypasses that redirect.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const out = (line: string) => realStdoutWrite(line + '\n');

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
 */
async function startEngine(opts: CliOpts): Promise<{ engine: DriveEngine; kv: NodeKVStore; wsAdapter: any }> {
  const relayUrl = opts.relay ?? process.env.DRIVE_RELAY_URL ?? PRODUCTION_RELAY_URL;
  const dataDir = resolveDataDir(opts);

  // Patch the keyhive slim build + initialize the subduction WASM for Node, both
  // before the bridge is imported / the Repo is created (in engine.init).
  ensureKeyhiveNodeShim();
  await initSubductionNode();

  fs.mkdirSync(dataDir, { recursive: true });
  const secureDir = path.join(dataDir, 'secure');
  fs.mkdirSync(secureDir, { recursive: true });

  console.error(`[cli] relay=${relayUrl} data-dir=${dataDir}`);

  const kv = new NodeKVStore(path.join(dataDir, 'kv.json'));
  const storage = new NodeFSStorageAdapter(secureDir);
  const wsAdapter = new WebSocketClientAdapter(relayUrl);
  const rdvEncoder = new Encoder({ tagUint8Array: false, useRecords: false });
  let rdvHandler: ((frame: any) => void) | null = null;

  // Intercept rendezvous overlay frames off the raw socket before the repo sees them.
  const origReceive = wsAdapter.receiveMessage.bind(wsAdapter);
  (wsAdapter as any).receiveMessage = (bytes: Uint8Array) => {
    try {
      const decoded = cborDecode(new Uint8Array(bytes));
      if (isRendezvousType(decoded?.type)) { rdvHandler?.(decoded); return; }
    } catch { /* not an overlay frame — fall through to the repo adapter */ }
    return origReceive(bytes);
  };

  const network: EngineNetwork = {
    networkAdapter: wsAdapter,
    sendOverlayFrame: (frame) => {
      // Read the socket lazily: the keyhive integration may re-wrap the adapter,
      // and the socket is (re)created on connect/reconnect.
      const sock: any = (wsAdapter as any).socket;
      if (sock && sock.readyState === 1) sock.send(rdvEncoder.encode(frame));
    },
    onRendezvousFrame: (handler) => { rdvHandler = handler; },
  };

  const emit = (event: WorkerToMain): void => {
    // Log every emitted engine event to stderr. A few get a friendlier one-line
    // summary; the rest fall through to a generic dump so nothing is dropped.
    switch (event.type) {
      case 'ready': console.error(`[cli] ready, peerId=${event.peerId}`); return;
      case 'kh-ready': console.error('[cli] keyhive ready'); return;
      case 'kh-error': console.error('[cli] keyhive error:', event.message); return;
      case 'error': console.error('[cli] error:', event.message); return;
      case 'data-warning': console.error('[cli] warning:', event.message); return;
      case 'peer-connected':
      case 'peer-disconnected': console.error(`[cli] peers: ${event.peerCount}`); return;
      case 'doc-list-updated': console.error(`[cli] doc list: ${event.list.length} doc(s)`); return;
      case 'kh-rdv-event':
        console.error(`[cli] link ${event.status}${event.message ? `: ${event.message}` : ''}`); return;
      default: console.error(`[cli] event ${event.type}`, event); return;
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
  console.error('[cli] no stored identity — link this device first:');
  console.error('[cli]   npm run cli -- accept-invite "https://…/#/link-device/r.<id>.<key>"');
  process.exit(1);
}

/** Poll (up to ~20s) for the keyhive group graph to sync so accessible docs surface. */
async function waitForDocs(engine: DriveEngine): Promise<string[]> {
  console.error('[cli] waiting for documents to sync…');
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

  // ── accept-invite: link this device, then exit ─────────────────────────────
  withRelay(withDataDir(program.command('accept-invite <url>')))
    .description('link this device from a device-invite/rendezvous URL, then exit')
    .action(async (url: string, opts: CliOpts) => {
      const parsed = parseRendezvousToken(url);
      if (!parsed) {
        console.error('[cli] could not parse an invite from the given URL/token (expected …/link-device/r.<id>.<key>).');
        process.exit(1);
      }
      const { engine, wsAdapter } = await startEngine(opts);
      // Rendezvous frames ride the raw relay socket — it must be OPEN before we
      // subscribe, or the RDV_SUB is dropped and the other device waits forever.
      console.error('[cli] connecting to relay…');
      await waitForRelayConnection(wsAdapter, 20_000);
      console.error('[cli] linking device via rendezvous…');
      await engine.rendezvousLinkJoin(parsed.rendezvousId, parsed.key);
      // Flush the return handshake frame before exiting, or the other device hangs
      // (stuck "Exchanging keys…") waiting for a frame we killed before it flushed.
      await drainRelay(wsAdapter);
      console.error('[cli] device linked.');
      process.exit(0);
    });

  // ── list: print every accessible document, then exit ────────────────────────
  withDataDir(program.command('list'))
    .description('print every accessible document (id, versions, last-modified), then exit')
    .action(async (opts: CliOpts) => {
      const { engine, kv } = await startEngine(opts);
      await requireLinked(kv);
      const ids = await waitForDocs(engine);
      console.error(`[cli] ${ids.length} accessible document(s).`);
      for (const id of ids) {
        const meta = await engine.getDocMeta(id);
        const at = meta.lastModified ? new Date(meta.lastModified * 1000).toISOString() : 'unknown';
        out(`${id}  versions=${meta.versions ?? 0}  updated=${at}`);
      }
      process.exit(0);
    });

  // ── show: render a document's current version as JSON, then exit ────────────
  withDataDir(program.command('show <docId>'))
    .description("render a document's current version as JSON to stdout, then exit")
    .action(async (docId: string, opts: CliOpts) => {
      const { engine, kv } = await startEngine(opts);
      await requireLinked(kv);
      console.error('[cli] loading document…');
      // getDocJson blocks on whenReady() (the doc may still be syncing) — cap it
      // so an inaccessible/never-arriving doc fails cleanly instead of hanging.
      const timeout = sleep(30_000).then(() =>
        Promise.reject(new Error('timed out waiting for the document to sync (is it accessible to this device?)')));
      let doc: any;
      try {
        doc = await Promise.race([engine.getDocJson(docId), timeout]);
      } catch (err) {
        console.error('[cli]', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      if (doc == null) {
        console.error('[cli] document not found or empty.');
        process.exit(1);
      }
      out(JSON.stringify(doc, null, 2));
      process.exit(0);
    });

  // ── sync: the long-running watch/server loop ────────────────────────────────
  withRelay(withDataDir(program.command('sync')))
    .description('keep the N most-recent docs open and rotate the rest, syncing continuously (Ctrl-C to stop)')
    .option('--keep-open <n>', 'minimum number of most-recently-updated docs to keep open', intArg,
      process.env.DRIVE_KEEP_OPEN ? intArg(process.env.DRIVE_KEEP_OPEN) : 10)
    .option('--recent-days <days>', 'also keep open every doc edited within this many days', intArg,
      process.env.DRIVE_RECENT_DAYS ? intArg(process.env.DRIVE_RECENT_DAYS) : 30)
    .option('--sync-seconds <seconds>', 'seconds to hold each rotated doc open so it can sync', intArg,
      process.env.DRIVE_SYNC_SECONDS ? intArg(process.env.DRIVE_SYNC_SECONDS) : 120)
    .action(async (opts: CliOpts) => {
      const { keepOpen = 10, recentDays = 30, syncSeconds = 120 } = opts;

      // Verify this device is linked BEFORE startEngine writes anything (kv.json,
      // keyhive archive, repo storage). Reading kv.json does not create files.
      await requireLinked(new NodeKVStore(path.join(resolveDataDir(opts), 'kv.json')));

      const { engine } = await startEngine(opts);
      const ids = await waitForDocs(engine);
      console.error(`[cli] ${ids.length} accessible document(s).`);

      const onUpdate = (u: WatchUpdate): void => {
        const at = u.lastModified ? new Date(u.lastModified * 1000).toISOString() : 'unknown';
        console.error(`[cli] update ${u.docId} type=${u.docType ?? '?'} name=${JSON.stringify(u.name ?? '')} versions=${u.versions ?? 0} at=${at}`);
      };
      await engine.startWatching({ keepOpen, recentDays, syncMs: syncSeconds * 1000 }, onUpdate);
      console.error(`[cli] syncing (keep-open=${keepOpen}, recent-days=${recentDays}, sync=${syncSeconds}s). Ctrl-C to stop.`);

      const shutdown = () => {
        console.error('[cli] shutting down…');
        engine.stopWatching();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  // No subcommand → print help to stderr and exit non-zero (there is no default).
  program.action(() => {
    program.outputHelp({ error: true });
    process.exit(1);
  });

  await program.parseAsync();
}

main().catch((err) => {
  console.error('[cli] fatal:', err);
  process.exit(1);
});
