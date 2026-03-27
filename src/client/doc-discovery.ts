/** Whether a discovered doc should be added to the list (not already known, not dismissed). */
export function isDiscoverable(amDocId: string, knownIds: Set<string>, dismissed: Set<string>): boolean {
  if (knownIds.has(amDocId)) return false;
  if (dismissed.has(amDocId)) return false;
  return true;
}
