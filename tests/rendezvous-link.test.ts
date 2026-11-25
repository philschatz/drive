/**
 * Linking a device, engine to engine, over a relay that only forwards.
 *
 * The link in a QR is a bearer secret: whoever gets it can ask to become a
 * device of the account. So the device that showed it does not add anything on
 * receipt. It reports who is asking, and adds the device only when the person
 * says so. Until then neither device has changed anything; a link nobody
 * completed stops working after a few minutes.
 *
 * Real rendezvous crypto and the real engine handlers; keyhive is replaced by
 * a stand-in that records what it was asked to do.
 */
import { DriveEngine } from '../src/shared/drive-engine';
import { RDV_SUB, RDV_UNSUB, RDV_MSG, RDV_PEER } from '../src/shared/rendezvous-protocol';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

/** A relay as far as rendezvous goes: who is on a topic, and frames passed to everyone else on it. */
function makeRelay() {
  const topics = new Map<string, Set<Device>>();
  const sent: Array<{ from: Device; frame: any }> = [];
  return {
    sent,
    handle(from: Device, frame: any) {
      sent.push({ from, frame });
      const members = topics.get(frame.rendezvousId) ?? new Set<Device>();
      topics.set(frame.rendezvousId, members);
      if (frame.type === RDV_SUB) {
        const others = [...members];
        members.add(from);
        for (const other of others) {
          other.engine.handleRendezvousFrame({ type: RDV_PEER, rendezvousId: frame.rendezvousId });
          from.engine.handleRendezvousFrame({ type: RDV_PEER, rendezvousId: frame.rendezvousId });
        }
      } else if (frame.type === RDV_UNSUB) {
        members.delete(from);
      } else if (frame.type === RDV_MSG) {
        for (const other of members) if (other !== from) other.engine.handleRendezvousFrame(frame);
      }
    },
    /** Hand a frame to a device as if the relay had sent it. */
    deliver(to: Device, frame: any) { to.engine.handleRendezvousFrame(frame); },
    on(rendezvousId: string) { return [...(topics.get(rendezvousId) ?? [])]; },
  };
}

interface Device {
  name: string;
  agentId: string;
  engine: any;
  events: any[];
  linkDevice: jest.Mock;
  putDeviceName: jest.Mock;
  adoptDriveSettingsDoc: jest.Mock;
  status(rendezvousId: string): string[];
  last(rendezvousId: string, status: string): any;
}

function makeDevice(relay: ReturnType<typeof makeRelay>, name: string, groupId: string | null): Device {
  const events: any[] = [];
  const engine: any = new DriveEngine({
    emit: (e: any) => events.push(e),
    network: { sendOverlayFrame: (frame: any) => relay.handle(device, frame) },
  } as any);
  const agentId = `agent-${name}`;
  const linkDevice = jest.fn(async (_agentId: string, peerGroupId?: string | null) => {
    groupId = groupId ?? peerGroupId ?? null;
    return { userGroupId: groupId, linked: true };
  });
  engine.khOps = {
    ensureUserGroup: async () => groupId,
    getUserGroupId: async () => groupId,
    previewContactCard: async () => `card:${agentId}`,
    getContactCard: async () => `card:${agentId}`,
    getIdentity: async () => ({ agentId }),
    receiveContactCard: async (card: string) => {
      const who = card.replace(/^card:/, '');
      return { agentId: who, isOwnCard: who === agentId, groupId: null };
    },
    linkDevice,
  };
  engine.ensureDriveSettingsDoc = async () => {};
  engine.driveSettingsDocId = groupId ? `settings-of-${name}` : null;
  const putDeviceName = jest.fn(async () => {});
  const adoptDriveSettingsDoc = jest.fn(async () => {});
  engine.putDeviceName = putDeviceName;
  engine.adoptDriveSettingsDoc = adoptDriveSettingsDoc;
  engine.reconcileHomeDocsAfterLink = async () => {};
  const rdvEvents = (rid: string) => events.filter((e) => e.type === 'kh-rdv-event' && e.rendezvousId === rid);
  const device: Device = {
    name, agentId, engine, events, linkDevice, putDeviceName, adoptDriveSettingsDoc,
    status: (rid) => rdvEvents(rid).map((e) => e.status),
    last: (rid, status) => rdvEvents(rid).filter((e) => e.status === status).at(-1),
  };
  return device;
}

let nextRequest = 1;
async function request(device: Device, msg: Record<string, any>): Promise<any> {
  const id = nextRequest++;
  await device.engine.handleMessage({ ...msg, id });
  const result = device.events.find((e) => e.type === 'result' && e.id === id);
  if (!result) throw new Error(`no result for ${msg.type}`);
  if (result.error) throw new Error(result.error);
  return result.result;
}

/** The laptop shows a link; the phone opens it. Returns once the laptop is asking its user. */
async function untilAsked(opts: { ttlMs?: number } = {}) {
  const relay = makeRelay();
  const laptop = makeDevice(relay, 'laptop', 'group-phil');
  const phone = makeDevice(relay, 'phone', null);
  if (opts.ttlMs) { laptop.engine.rdvHostTtlMs = opts.ttlMs; phone.engine.rdvHostTtlMs = opts.ttlMs; }
  const { rendezvousId, key } = await request(laptop, { type: 'kh-rdv-link-create', deviceName: 'Laptop' });
  const joining: Promise<{ ok: true }> = phone.engine.rendezvousLinkJoin(rendezvousId, key, 'Phone');
  joining.catch(() => { /* asserted by the test that expects it */ });
  await waitFor(() => laptop.status(rendezvousId).includes('confirm'), 'the laptop to ask');
  await waitFor(() => phone.status(rendezvousId).includes('confirm'), 'the phone to say it is waiting for the answer');
  // Yes is the confirm message; no is walking away from the link.
  const answer = (accept: boolean) => laptop.engine.handleMessage(
    accept ? { type: 'kh-rdv-link-confirm', rendezvousId } : { type: 'kh-rdv-cancel', rendezvousId });
  return { relay, laptop, phone, rendezvousId, key, joining, answer };
}

describe('linking a device', () => {
  it('asks first, naming the device, and neither has changed anything', async () => {
    const { laptop, phone, rendezvousId } = await untilAsked();
    expect(laptop.last(rendezvousId, 'confirm').deviceName).toBe('Phone');
    // The phone says where the answer has to come from (this is what the CLI prints).
    expect(phone.last(rendezvousId, 'confirm').message).toMatch(/confirm there/i);

    expect(laptop.linkDevice).not.toHaveBeenCalled();
    expect(phone.linkDevice).not.toHaveBeenCalled();
    expect(phone.adoptDriveSettingsDoc).not.toHaveBeenCalled();
    expect(laptop.status(rendezvousId)).not.toContain('linked');
  });

  it('links both ways once the person confirms', async () => {
    const { relay, laptop, phone, rendezvousId, joining, answer } = await untilAsked();
    await answer(true);
    await expect(joining).resolves.toEqual({ ok: true });

    // The laptop added the phone (which had no group of its own); the phone adopted the laptop's.
    expect(laptop.linkDevice).toHaveBeenCalledWith(phone.agentId, null);
    expect(phone.linkDevice).toHaveBeenCalledWith(laptop.agentId, 'group-phil');
    expect(phone.adoptDriveSettingsDoc).toHaveBeenCalledWith('settings-of-laptop');
    expect(laptop.putDeviceName).toHaveBeenCalledWith(phone.agentId, 'Phone');
    expect(laptop.putDeviceName).toHaveBeenCalledWith(laptop.agentId, 'Laptop');
    expect(laptop.status(rendezvousId).at(-1)).toBe('linked');
    expect(phone.status(rendezvousId).at(-1)).toBe('linked');
    // Both have left the topic, and neither keeps a session.
    expect(relay.on(rendezvousId)).toEqual([]);
    expect(laptop.engine.rdvSessions.size + phone.engine.rdvSessions.size).toBe(0);
  });

  it('adds nothing when the person says it is not their device', async () => {
    const { relay, laptop, phone, rendezvousId, joining, answer } = await untilAsked();
    await answer(false);
    await expect(joining).rejects.toThrow(/did not accept/);
    expect(laptop.linkDevice).not.toHaveBeenCalled();
    expect(phone.linkDevice).not.toHaveBeenCalled();
    expect(phone.adoptDriveSettingsDoc).not.toHaveBeenCalled();
    expect(phone.status(rendezvousId).at(-1)).toBe('error');
    expect(relay.on(rendezvousId)).toEqual([]);
    // The answer was final: saying yes afterwards does nothing.
    await answer(true);
    expect(laptop.linkDevice).not.toHaveBeenCalled();
  });

  it('asks about the first device only: a second one holding the link cannot take its place', async () => {
    const { relay, laptop, phone, rendezvousId, key, joining, answer } = await untilAsked();
    // Someone else has the link too, and asks while the question is on screen.
    const intruder = makeDevice(relay, 'intruder', null);
    const intruding: Promise<unknown> = intruder.engine.rendezvousLinkJoin(rendezvousId, key, 'Not the phone');
    intruding.catch(() => {});
    await waitFor(() => intruder.status(rendezvousId).includes('confirm'), 'the intruder to have sent its card');
    await tick(20);

    // The laptop is still asking about the phone, and only about the phone.
    expect(laptop.status(rendezvousId).filter((s) => s === 'confirm')).toHaveLength(1);
    expect(laptop.last(rendezvousId, 'confirm').deviceName).toBe('Phone');
    await answer(true);
    await expect(joining).resolves.toEqual({ ok: true });
    expect(laptop.linkDevice).toHaveBeenCalledTimes(1);
    expect(laptop.linkDevice).toHaveBeenCalledWith(phone.agentId, null);
  });

  it('a link nobody completed stops working', async () => {
    const relay = makeRelay();
    const laptop = makeDevice(relay, 'laptop', 'group-phil');
    laptop.engine.rdvHostTtlMs = 40;
    const { rendezvousId, key } = await request(laptop, { type: 'kh-rdv-link-create', deviceName: 'Laptop' });
    await waitFor(() => laptop.status(rendezvousId).includes('expired'), 'the link to expire');
    expect(laptop.engine.rdvSessions.has(rendezvousId)).toBe(false);
    expect(relay.on(rendezvousId)).toEqual([]);

    // Opening it afterwards reaches nobody.
    const phone = makeDevice(relay, 'phone', null);
    const joining: Promise<unknown> = phone.engine.rendezvousLinkJoin(rendezvousId, key, 'Phone');
    joining.catch(() => {});
    await tick(60);
    expect(laptop.status(rendezvousId)).not.toContain('confirm');
    expect(phone.status(rendezvousId)).toEqual(['waiting']);
    await phone.engine.handleMessage({ type: 'kh-rdv-cancel', rendezvousId });
  });

  it('a question nobody answered expires too, and tells the waiting device no', async () => {
    const { laptop, phone, rendezvousId, joining } = await untilAsked({ ttlMs: 150 });
    await expect(joining).rejects.toThrow(/did not accept/);
    await waitFor(() => laptop.status(rendezvousId).includes('expired'), 'the link to expire');
    expect(laptop.linkDevice).not.toHaveBeenCalled();
    expect(phone.linkDevice).not.toHaveBeenCalled();
  });

  it('a device is not fooled by its own message handed back to it', async () => {
    const relay = makeRelay();
    const laptop = makeDevice(relay, 'laptop', 'group-phil');
    const { rendezvousId } = await request(laptop, { type: 'kh-rdv-link-create', deviceName: 'Laptop' });
    // Something joins the topic, so the laptop sends its card …
    relay.deliver(laptop, { type: RDV_PEER, rendezvousId });
    await waitFor(() => relay.sent.some((s) => s.from === laptop && s.frame.type === RDV_MSG), 'the laptop to send its card');
    const own = relay.sent.find((s) => s.from === laptop && s.frame.type === RDV_MSG)!.frame;
    // … and the relay hands that very frame back, as if it were the other device's.
    relay.deliver(laptop, own);
    await tick(30);
    expect(laptop.status(rendezvousId)).not.toContain('confirm');
    expect(laptop.status(rendezvousId)).not.toContain('receiving');
    // The session is still there for the real device: a reflected frame cancels nothing.
    expect(laptop.engine.rdvSessions.has(rendezvousId)).toBe(true);
    await laptop.engine.handleMessage({ type: 'kh-rdv-cancel', rendezvousId });
  });
});

describe('a friend link', () => {
  it('stops working when nobody opened it in time', async () => {
    const relay = makeRelay();
    const alice = makeDevice(relay, 'alice', 'group-alice');
    alice.engine.rdvHostTtlMs = 40;
    const { rendezvousId } = await request(alice, { type: 'kh-rdv-create-share', displayName: 'Alice' });
    await waitFor(() => alice.status(rendezvousId).includes('expired'), 'the link to expire');
    expect(alice.engine.rdvSessions.has(rendezvousId)).toBe(false);
    expect(relay.on(rendezvousId)).toEqual([]);
  });
});
