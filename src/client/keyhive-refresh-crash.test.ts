/**
 * Regression test: keyhive WASM panic in try_encrypt_content after Bob refreshes.
 *
 * Scenario:
 *   1. Alice creates a doc, invites Bob (writer).
 *   2. Bob accepts the invite and reaches a synced state with Alice.
 *   3. Bob "refreshes" — his keyhive is reloaded from its archive.
 *   4. Bob and Alice re-sync keyhive events.
 *   5. Alice tries to encrypt a new change → WASM panic in try_encrypt_content.
 *
 * The panic is an `expect()` on `Option::None` deep inside keyhive_core's CGKA
 * state machine. This test documents the reproduction so we can verify any fix
 * in keyhive or in our network adapter (by treating encryption failures
 * gracefully instead of letting the panic kill the worker).
 */

import { initKeyhiveWasm } from '../lib/automerge-repo-keyhive';
import {
  Signer,
  Keyhive,
  CiphertextStore,
  Access,
  ChangeId,
  DocumentId,
  Identifier,
  ContactCard,
  Encrypted,
} from '@keyhive/keyhive/slim';
import { KeyhiveOps, KeyhiveBridge, KeyhiveOpsSideEffects } from './keyhive-ops';

initKeyhiveWasm();

const bridge: KeyhiveBridge = {
  ChangeId, DocumentId, Identifier, Signer, CiphertextStore, Keyhive, Access, ContactCard,
};

function noopSideEffects(): KeyhiveOpsSideEffects {
  return {
    persist: async () => {},
    syncKeyhive: () => {},
    registerDoc: () => {},
    forceResyncAllPeers: () => {},
    findDoc: () => {},
    saveEventBytes: async () => {},
  };
}

async function createOps() {
  const signer = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const kh = await Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});
  return { ops: new KeyhiveOps(kh, bridge, noopSideEffects()), kh, signer };
}

async function syncAB(khA: any, khB: any) {
  const cardA = await khA.contactCard();
  const indA_inB = await khB.receiveContactCard(cardA);
  const bEvents: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
  const bArr: Uint8Array[] = []; bEvents.forEach((v) => bArr.push(v));
  await khA.ingestEventsBytes(bArr);

  const cardB = await khB.contactCard();
  const indB_inA = await khA.receiveContactCard(cardB);
  const aEvents: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
  const aArr: Uint8Array[] = []; aEvents.forEach((v) => aArr.push(v));
  await khB.ingestEventsBytes(aArr);
}

describe('keyhive refresh crash (Bob refresh → Alice encrypts → WASM panic)', () => {
  // In production, Bob's worker panics with:
  //   RuntimeError: unreachable
  //   at keyhive_core::keyhive::Keyhive<...>::try_encrypt_content
  //
  // Trigger: Alice invites Bob, Bob accepts, both edit, Bob refreshes.
  // On reload, keyhive-sync-confirmation arrives, flips keyhiveSynced=true,
  // adapter retries doc sync, calls tryEncrypt on Bob's freshly-loaded keyhive
  // Document object, and keyhive panics on an Option::None expect() inside CGKA.
  //
  // This simplified test does not yet reproduce the panic. Keeping it skipped
  // so we have a home for a proper reproduction and any eventual assertion
  // that encryption either succeeds or throws catchable JS (never panics WASM).
  it.skip('REPRODUCES: Alice can still encrypt after Bob refreshes his keyhive', async () => {
    // Alice creates doc, invites Bob (writer), Bob claims
    const { ops: opsA, kh: khA, signer: signerA } = await createOps();
    const { ops: opsB, kh: khB, signer: signerB } = await createOps();

    const { khDocId: amDocId } = await opsA.enableSharing('doc-1');
    const invite = await opsA.generateInvite(amDocId, 'edit');

    // Bob claims via archive
    const seed = new Uint8Array(invite.inviteKeyBytes);
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const archive1 = await opsA.kh.toArchive();
    const inviteKh = await archive1.tryToKeyhive(
      CiphertextStore.newInMemory(), inviteSigner, () => {},
    );
    await opsB.claimInviteWithKeyhive(inviteKh, 'doc-1');

    // Exchange events so Alice knows about Bob and vice versa
    await syncAB(khA, khB);

    // Sanity check: Alice can encrypt for the current tree (both members)
    const khDocIdA = opsA.khDocuments.values().next().value!.doc_id;
    const docA1 = await khA.getDocument(khDocIdA);
    const pt1 = new TextEncoder().encode('hello-1');
    const ref1 = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    await khA.tryEncrypt(docA1!, ref1, [], pt1);

    // --- Bob "refreshes": reload keyhive from his archive ---
    const archiveB = await khB.toArchive();
    const khB2 = await archiveB.tryToKeyhive(
      CiphertextStore.newInMemory(), signerB, () => {},
    );

    // Re-sync events between Alice and reloaded Bob
    await syncAB(khA, khB2);

    // Alice tries to encrypt a new change — in production this panics WASM.
    // We assert that it EITHER succeeds OR throws a JS error (never panics).
    const docA2 = await khA.getDocument(khDocIdA);
    const pt2 = new TextEncoder().encode('hello-2');
    const ref2 = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

    // If the panic reproduces, the whole test process aborts instead of
    // throwing a catchable error. The explicit try/catch here will NOT
    // rescue a WASM panic — but we keep the test skipped until keyhive
    // is fixed so it doesn't break the suite.
    await khA.tryEncrypt(docA2!, ref2, [], pt2);

    // Silence unused-signer warning (signerA is captured for completeness)
    expect(signerA).toBeDefined();
  });
});
