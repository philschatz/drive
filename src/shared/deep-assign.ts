export function deepAssign<T extends Record<string, any>>(target: T, source: Partial<T>): void {
  for (const key in source) {
    if (!source.hasOwnProperty(key)) continue;

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
      target[key].length === 1 &&
      (sourceValue as Array<any>).length === 1
    ) {
      deepAssign(target[key], sourceValue);
    } else if (target[key] !== sourceValue) {
      target[key] = sourceValue as any;
    }
  }
}
