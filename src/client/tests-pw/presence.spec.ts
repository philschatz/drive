import { test, expect } from '@playwright/test';
import { setupSharedDoc, type SharedDocSetup } from './support/scenarios';
import { waitFor } from './support/peer';

/**
 * All three presence behaviors, one friend pair, one boot. Presence is the
 * most boot-expensive subsystem there is (two keyhive identities, two workers,
 * a contact exchange), and its three specs used to each pay for that; now they
 * share one `setupSharedDoc` pair.
 *
 * ORDER MATTERS — the file is serial for real reasons, not hygiene:
 *
 *  1. The late-joiner test needs bob presence-COLD (no subscription, no mount,
 *     no re-set loops on his side), so it must run before anything subscribes
 *     him. It ends with bob parked on the source viewer.
 *  2. The focused-field round-trip warms both peers up.
 *  3. The liveness test must run LAST: it shrinks the presence windows with
 *     setPresenceTiming (stale 3s / heartbeat 1s / check 1s) and closes alice
 *     for the silent-drop assertion.
 */
test.describe.configure({ mode: 'serial' });

let setup: SharedDocSetup;

test.beforeAll(async ({ browser }) => {
  setup = await setupSharedDoc(browser, 'edit');
});

test.afterAll(async () => {
  await Promise.all([setup?.alice.close(), setup?.bob.close()]);
});

/**
 * Cross-browser presence through the real UI, with NO presence re-set loops:
 * each view broadcasts its state once on mount, so the peer that opens the doc
 * LATER must still learn the earlier peer's state. That direction is covered by
 * usePresence's newcomer re-flush (re-announce the full local state when an
 * unseen peerId appears) — without it, alice's dot never reaches bob.
 *
 * The late joiner lands on the SOURCE viewer rather than a second editor: with
 * no worker warm-up, bob's first find can race the keyhive announce and reject
 * as unavailable, so the source viewer has to retry its way to the doc before
 * it can render a dot at all. Both peers must still see each other, so this is
 * strictly stronger than either case alone.
 */
// Previously fixme'd for the beekem pcs_key_ops panic (`unreachable executed`)
// on the late joiner's first presence encrypt: beekem's Cgka::new_app_secret_for
// expected the current root's PcsKey in pcs_key_ops, but that map was only
// populated on LOCAL update or on decrypt, so encrypting after ingesting a
// remote CGKA rekey panicked. Fixed in beekem; the newcomer re-flush is app-side.
test('views opened at different times see each other without re-broadcast loops', async () => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = setup;

  // Only ALICE's worker is warmed. Bob's is deliberately left cold so his first
  // find races the announce — the source viewer must recover on its own.
  await waitFor(
    () => alice.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
    (r) => r === 'Shared list',
    { label: 'alice loads doc', timeout: 45_000 }
  );

  // Alice opens the editor first; her viewing:true broadcast fires now,
  // while bob has nothing mounted.
  await alice.page.goto(`/#/d/${docId}`);
  // The title bar is the one thing every editor mounts (as static text now —
  // it used to be an input, which is what this locator was matching on).
  await expect(alice.page.getByTestId('doc-title')).toBeVisible({ timeout: 15_000 });
  await alice.page.waitForTimeout(3_000); // ensure her broadcast is long gone

  // Bob joins later, in the source viewer. He must see alice (via her newcomer
  // re-flush), and she must see him (his own mount broadcast) — neither side
  // re-sets its presence to help.
  await bob.page.goto(`/#/source/${docId}`);
  await expect(
    bob.page.locator('[data-testid="peer-dot"]'),
    "alice's dot renders for the late joiner, in the source viewer",
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(
    alice.page.locator('[data-testid="peer-dot"]'),
    "bob's (source viewer) dot renders for the early joiner",
  ).toHaveCount(1, { timeout: 30_000 });
});

/**
 * Presence is broadcast over the ephemeral-message channel, with each value
 * encrypted under the document's keyhive key (see encryptPresenceValue /
 * decryptPresenceValue in automerge-worker.ts). This exercises the full
 * round-trip in the real running app: alice sets a focused-field path, and bob
 * must receive the *decrypted* path — which only succeeds if the encrypt →
 * send → receive → decrypt path works end-to-end (and the keyhive WASM calls
 * are correctly serialized, i.e. no "unreachable executed" trap).
 */
test("a peer's focused field syncs to another peer (decrypted)", async () => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = setup;
  const FOCUS = ['tasks', 'demo-task', 'title'];
  const key = JSON.stringify(FOCUS);

  // Both peers must have the doc synced/loaded before starting presence — in the
  // real app the editor renders the doc (loading its handle) before initPresence.
  for (const p of [alice, bob]) {
    await waitFor(
      () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
      (r) => r === 'Shared list',
      { label: `${p.name} loads doc`, timeout: 45_000 }
    );
  }

  // Bob opens the doc, starts presence, and stashes incoming peer states.
  await bob.page.evaluate((d) => {
    (window as any).__bobPeers = {};
    (window as any).__drive.subscribePresence(d, (peers: any) => {
      (window as any).__bobPeers = peers;
    });
  }, docId);

  // Alice opens the doc and starts presence (so the two instances discover
  // each other and exchange ephemeral messages over the doc's sync channel).
  await alice.page.evaluate((d) => {
    (window as any).__drive.subscribePresence(d, () => {});
  }, docId);

  // Alice focuses a field; assert bob receives the identical, decrypted path.
  // Re-set on each poll: presence setup is async and a freshly-synced peer may
  // miss the first broadcast before its key material arrives.
  const peers = await waitFor(
    async () => {
      await alice.page.evaluate(
        ({ d, f }) => (window as any).__drive.setPresence(d, { focusedField: f }),
        { d: docId, f: FOCUS }
      );
      return bob.page.evaluate(() => (window as any).__bobPeers ?? {});
    },
    (states: any) =>
      Object.values(states).some((p: any) => JSON.stringify(p?.value?.focusedField) === key),
    { label: 'bob sees alice focused field (decrypted)', timeout: 60_000, interval: 1_000 }
  );

  const match = Object.values(peers).find(
    (p: any) => JSON.stringify(p?.value?.focusedField) === key
  );
  expect(match, 'a peer reports the decrypted focused-field path').toBeTruthy();

  // Convergence check: keep alice's focus set and sample bob over ~10s. Once
  // keyhive keys settle, every sample should decrypt to the same path (no flicker).
  const samples: boolean[] = [];
  for (let i = 0; i < 12; i++) {
    await alice.page.evaluate(
      ({ d, f }) => (window as any).__drive.setPresence(d, { focusedField: f }),
      { d: docId, f: FOCUS }
    );
    await bob.page.waitForTimeout(800);
    const states = await bob.page.evaluate(() => (window as any).__bobPeers ?? {});
    const ok = Object.values(states).some((p: any) => JSON.stringify(p?.value?.focusedField) === key);
    samples.push(ok);
  }
  // The last 5 samples (steady state, after keyhive keys settle) must all see the
  // decrypted path — i.e. presence is stable, not flickering on decrypt failures.
  expect(samples.slice(-5).every(Boolean), 'presence is stable in steady state').toBe(true);
});

/**
 * Presence liveness. The worker hides peers whose heartbeats stop
 * (PRESENCE_STALE_MS, checked every liveness tick — see drive-engine.ts), while
 * heartbeats alone keep an idle peer visible. To avoid sleeping past the 12s
 * production default, this test shrinks the windows via setPresenceTiming
 * (stale 3s / heartbeat 1s / check 1s) before presence starts. Two-peer
 * assertions:
 *
 *  1. Idle-but-alive: with zero presence traffic for 4s (> the 3s stale window),
 *     alice must STAY visible to bob — hiding is for missed heartbeats, not
 *     idleness. (Guards against the upstream library bug where idle peers were
 *     pruned despite heartbeating: markSeen bumps lastUpdateAt but prune()
 *     filters on lastActiveAt.)
 *
 *  2. Silent drop: closing alice's context kills her worker without a presence
 *     "goodbye" (nothing in the app sends one on unload). Her title-bar dot on
 *     bob's task list must disappear once her heartbeats go missing — this is
 *     what used to linger forever.
 */
test('idle peers stay visible; a silently-dropped peer disappears', async () => {
  test.setTimeout(120_000);
  const { alice, bob, docId } = setup;

  // Shrink the presence windows before any presence setup so the
  // idle/silent-drop assertions run in seconds, not past the 12s default.
  const timing = { staleMs: 3_000, heartbeatMs: 1_000, livenessCheckMs: 1_000 };
  for (const p of [alice, bob]) {
    await p.page.evaluate((t) => (window as any).__drive.setPresenceTiming(t), timing);
  }
  // Both peers must have the doc synced/loaded before starting presence
  // (the engine skips presence setup until the keyhive doc is ready).
  for (const p of [alice, bob]) {
    await waitFor(
      () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
      (r) => r === 'Shared list',
      { label: `${p.name} loads doc`, timeout: 45_000 }
    );
  }

  // Bob subscribes and stashes incoming peer states; alice subscribes too
  // (which broadcasts her initial viewing:true).
  await bob.page.evaluate((d) => {
    (window as any).__pwPeers = {};
    (window as any).__drive.subscribePresence(d, (peers: any) => {
      (window as any).__pwPeers = peers;
    });
  }, docId);
  await alice.page.evaluate((d) => {
    (window as any).__drive.subscribePresence(d, () => {});
  }, docId);

  // Mutual visibility. Re-set on each poll: presence setup is async and a
  // freshly-synced peer may miss the first broadcast before its key
  // material arrives (same pattern as the focused-field test).
  await waitFor(
    async () => {
      await alice.page.evaluate(
        (d) => (window as any).__drive.setPresence(d, { viewing: true }),
        docId
      );
      return bob.page.evaluate(() => (window as any).__pwPeers ?? {});
    },
    (states: any) => Object.values(states).some((p: any) => p?.value?.viewing === true),
    { label: 'bob sees alice viewing', timeout: 60_000, interval: 1_000 }
  );

  // 1. Idle-but-alive: no presence traffic for 4s (> the 3s stale
  // window). Only heartbeats flow, and they must keep alice visible.
  await bob.page.waitForTimeout(4_000);
  const idleStates = await bob.page.evaluate(() => (window as any).__pwPeers ?? {});
  expect(
    Object.values(idleStates).some((p: any) => p?.value?.viewing === true),
    'idle-but-heartbeating peer stays visible'
  ).toBe(true);

  // 2a. Warm path: bob opens the task list via in-app (hash) navigation —
  // same worker, presence in steady state (no emissions) — the editor must
  // still render alice's dot from the replayed last-known states.
  const dots = bob.page.locator('[data-testid="peer-dot"]');
  await bob.page.goto(`/#/d/${docId}`);
  await expect(dots, "alice's dot renders after in-app navigation").toHaveCount(1, {
    timeout: 30_000,
  });

  // 2b. Cold path: a real reload restarts bob's worker. The engine must
  // retry presence setup until the doc is ready, and alice must re-announce
  // her state to the fresh worker (empty-snapshot re-flush).
  await bob.page.reload();

  // Re-stash worker states in the reloaded page. The reload reset bob's
  // presence timing to defaults, so re-apply the short windows before
  // presence sets up again (keeps the silent-drop assertion fast).
  await bob.page.evaluate(
    async (arg) => {
      await (window as any).__drive.workerReady;
      await (window as any).__drive.setPresenceTiming(arg.timing);
      (window as any).__pwPeers = {};
      (window as any).__drive.subscribePresence(arg.docId, (peers: any) => {
        (window as any).__pwPeers = peers;
      });
    },
    { docId, timing }
  );
  await expect(dots, "alice's dot renders after a full reload").toHaveCount(1, {
    timeout: 60_000,
  });

  // Silent drop: no goodbye is sent — bob must notice the missing
  // heartbeats (≤ 3s stale + 1s check tick + emit/render; generous margin).
  await alice.close();
  await expect(dots, 'dot disappears after missed heartbeats').toHaveCount(0, {
    timeout: 15_000,
  });
  await waitFor(
    () => bob.page.evaluate(() => (window as any).__pwPeers ?? {}),
    (states: any) => !Object.values(states).some((p: any) => p?.value?.viewing === true),
    { label: 'alice leaves bob worker states', timeout: 15_000 }
  );
});
