/**
 * Simple LRU cache using Map insertion order.
 * No external dependencies.
 */
export class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value!);
    }
  }

  delete(key: K) { this.map.delete(key); }

  /** Delete all entries whose key (must be string) starts with the given prefix. */
  deletePrefix(prefix: string) {
    for (const key of this.map.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) this.map.delete(key);
    }
  }

  /** Iterate all keys (no LRU reordering). */
  keys(): IterableIterator<K> { return this.map.keys(); }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}
