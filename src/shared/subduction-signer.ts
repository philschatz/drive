/**
 * The Repo's subduction identity: this device's keyhive key.
 *
 * Subduction signs its handshake and every commit with a `Signer`, and a peer
 * is known to it by that signer's verifying key. Handing it the device's
 * keyhive key makes the identities one: the key a peer proves to the secure
 * channel, the key it proves in the subduction handshake, and the key keyhive's
 * membership graph is about are the same key — so the document policy can ask
 * keyhive what that peer may see, and a commit's signature says which device
 * wrote it.
 *
 * `Signer` is an interface subduction lets JavaScript implement, so the private
 * key is used where it lives (WebCrypto) and never exported. The bridge's own
 * route (`constructSubductionSigner`) copies the private scalar into a WASM
 * `MemorySigner`; it also needs the hive, which does not exist yet when the
 * Repo — and with it this signer — is constructed. Hence the promise.
 */
import { deviceKeyOfPeerId } from './secure-channel';

/** Subduction's `Signer` interface. */
export interface SubductionSigner {
  /** The 64-byte Ed25519 signature of `message`. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  /** The 32-byte Ed25519 verifying key. */
  verifyingKey(): Uint8Array;
}

/**
 * A signer for the device whose key is in `peerId`. `privateKey` may still be
 * pending when this is built; nothing is signed before a connection or a
 * document exists, both of which come after it resolves.
 */
export function makeDeviceSigner(peerId: string, privateKey: Promise<CryptoKey>): SubductionSigner {
  const key = deviceKeyOfPeerId(peerId);
  return {
    verifyingKey: () => key.slice(),
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', await privateKey, message as BufferSource)),
  };
}
