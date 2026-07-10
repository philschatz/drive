export function deepAssign<T extends Record<string, any>>(target: T, source: Partial<T>): void {
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    // Untrusted input (JSON.parse, ICS/CalDAV) can carry an OWN enumerable
    // "__proto__" key; recursing into target["__proto__"] would write onto
    // Object.prototype. Skip all prototype-polluting keys.
    const k: string = key;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;

    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue === undefined) {
      delete target[key];
      continue;
    }

    if (sourceValue === null) {
      if (targetValue !== null) target[key] = sourceValue as any;
      continue;
    }

    if (
      key === 'categories' &&
      JSON.stringify(targetValue) !== JSON.stringify(sourceValue)
    ) {
      target[key] = sourceValue;
    } else if (
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      deepAssign(targetValue, sourceValue);
    } else if (
      Array.isArray(target[key]) &&
      Array.isArray(sourceValue) &&
      target[key].length === (sourceValue as Array<any>).length
    ) {
      deepAssign(target[key], sourceValue);
    } else if (target[key] !== sourceValue) {
      target[key] = sourceValue as any;
    }
  }
}
