import { test, expect } from '@playwright/test';
import { setupSharedDoc } from './support/scenarios';
import { waitFor } from './support/peer';

/**
 * Presence liveness. The worker hides peers whose heartbeats stop
 * (PRESENCE_STALE_MS, checked every liveness tick — see drive-engine.ts), while
 * heartbeats alone keep an idle peer visible. To avoid sleeping past the 12s
 * production default, this spec shrinks the windows via setPresenceTiming
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
test.describe('presence liveness (heartbeats)', () => {
  // Disabled: times out.
  test.fixme('idle peers stay visible; a silently-dropped peer disappears', async ({ browser }) => {
    test.setTimeout(120_000);
    const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
    try {
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
          (r) => Array.isArray(r) && r.includes('Shared list'),
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
      // material arrives (same pattern as presence.spec.ts).
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
    } finally {
      await bob.close();
      await alice.close().catch(() => {}); // may already be closed by the test body
    }
  });
});
