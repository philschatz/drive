import { Signer } from "@keyhive/keyhive/slim";
import { peerIdFromVerifyingKey } from "./network-adapter/messages";
import { PeerId } from "@automerge/automerge-repo/slim";
import { Agent, Identifier, Keyhive } from "@keyhive/keyhive/slim";

export function peerIdFromSigner(signer: Signer, suffix: string = ""): PeerId {
  return peerIdFromVerifyingKey(signer.verifyingKey, suffix);
}

/** Returns true if the peer ID prefix is a valid base64-encoded Ed25519 verifying key (32 bytes). */
export function isKeyhivePeerId(peerId: PeerId): boolean {
  const prefix = verifyingKeyPeerIdWithoutSuffix(peerId);
  try {
    const bytes = Uint8Array.from(atob(prefix), (c) => c.charCodeAt(0));
    return bytes.length === 32;
  } catch {
    return false;
  }
}

export function keyhiveIdentifierFromPeerId(peerId: PeerId): Identifier {
  const peerIdPrefix = verifyingKeyPeerIdWithoutSuffix(peerId);
  try {
    const verifyingKeyBytes = Uint8Array.from(atob(peerIdPrefix), (c) =>
      c.charCodeAt(0)
    );
    return new Identifier(verifyingKeyBytes);
  } catch (error) {
    throw new Error(`Failed to decode peer ID: ${peerId}`, { cause: error });
  }
}

export function verifyingKeyPeerIdWithoutSuffix(peerId: PeerId): PeerId {
  return peerId.split("-")[0] as PeerId;
}

export function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function getEventsForAgent(
  keyhive: Keyhive,
  agent: Agent,
): Promise<Map<Uint8Array, any>> {
  return await keyhive.eventsForAgent(agent);
}

// Returns event hashes for an agent as Map<hashString, hashBytes>
export async function getEventHashesForAgent(
  keyhive: Keyhive,
  agent: Agent,
): Promise<Map<string, Uint8Array>> {
  const hashMap = new Map<string, Uint8Array>();

  // eventsForAgent returns Map<hashBytes, eventBytes> — we only need the keys
  const events: Map<Uint8Array, any> = await keyhive.eventsForAgent(agent);
  for (const hashBytes of events.keys()) {
    hashMap.set(hashBytes.toString(), hashBytes);
  }

  // keyOps returns Map<hashBytes, eventBytes> — prekey operation hashes
  const keyOps: Map<Uint8Array, any> = await agent.keyOps();
  for (const hashBytes of keyOps.keys()) {
    hashMap.set(hashBytes.toString(), hashBytes);
  }

  return hashMap;
}
