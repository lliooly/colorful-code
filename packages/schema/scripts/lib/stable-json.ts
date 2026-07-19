const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

const normalize = (value: unknown, ancestors: ReadonlySet<object>): unknown => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('stable JSON rejects non-finite numbers');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`stable JSON rejects ${typeof value} values`);
  }
  if (ancestors.has(value)) throw new TypeError('stable JSON rejects cycles');

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError('stable JSON rejects sparse arrays');
      }
    }
    return value.map((item) => normalize(item, nextAncestors));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('stable JSON accepts only plain objects');
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: normalize((value as Record<string, unknown>)[key], nextAncestors),
      writable: true,
    });
  }
  return result;
};

export const stableJson = (value: unknown): string =>
  `${JSON.stringify(normalize(value, new Set()), null, 2)}\n`;
