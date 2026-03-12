export interface InviteRecord {
  id: string;
  khDocId: string;
  inviteUrl: string;
  role: string;
  createdAt: number;
  inviteSignerAgentId: string;
  /** agentIds of members BEFORE this invite was generated */
  baselineAgentIds: string[];
}

const KEY = 'automerge-invites';

function loadAll(): InviteRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveAll(records: InviteRecord[]) {
  localStorage.setItem(KEY, JSON.stringify(records));
}

export function getInviteRecords(khDocId: string): InviteRecord[] {
  return loadAll().filter(r => r.khDocId === khDocId);
}

export function addInviteRecord(record: InviteRecord): void {
  const all = loadAll();
  all.push(record);
  saveAll(all);
}

export function removeInviteRecord(id: string): void {
  saveAll(loadAll().filter(r => r.id !== id));
}
