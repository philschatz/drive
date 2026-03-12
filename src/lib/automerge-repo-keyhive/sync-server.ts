import { PeerId } from "@automerge/automerge-repo/slim";
import { ContactCard, Keyhive } from "@keyhive/keyhive/slim";
import { KeyhiveStorage, receiveContactCard } from "./keyhive/keyhive";

let KH_DEBUG = false;
function debug(...args: any[]) { if (KH_DEBUG) console.log('[AMRepoKeyhive]', ...args); }

export type SyncServer = {
  individualId: Uint8Array;
  contactCard: ContactCard;
  peerId: PeerId;
};

export async function syncServerFromContactCard(
  contactCardJson: string,
  serverPeerId: PeerId,
  keyhive: Keyhive,
  keyhiveStorage: KeyhiveStorage
): Promise<SyncServer> {
  debug(
    "syncServerFromContactCard: parsing server contact card"
  );
  const serverContactCard = ContactCard.fromJson(contactCardJson);
  const serverIndividual = await receiveContactCard(
    keyhive,
    serverContactCard,
    keyhiveStorage
  );
  if (!serverIndividual) {
    throw Error(`Invalid server contact card: ${contactCardJson}`);
  }

  const individualId = serverIndividual.id.toBytes();

  return {
    individualId,
    contactCard: serverContactCard,
    peerId: serverPeerId,
  };
}
