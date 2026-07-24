/**
 * Human-readable byte size (decimal units: 1 KB = 1000 B).
 *
 * Shared by the worker (rendezvous transfer sizes) and the UI (sender-page
 * payload estimate) so both surfaces show identical numbers.
 */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}
