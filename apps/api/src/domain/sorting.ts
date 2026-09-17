/**
 * Deterministic ordering helpers.
 *
 * Spec: the same input must always produce the same order, or the board
 * shuffles under the user on every refresh. Comparisons are ordinal on
 * purpose — `localeCompare` depends on the host's ICU data, which is not
 * the same thing on every container.
 */

/** Ordinal string comparison. Stable across hosts and locales. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Case-insensitive label ordering, falling back to the ordinal one. */
export function compareLabels(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return compareStrings(left, right) || compareStrings(a, b);
}

/** Numeric comparison that treats a missing position as last. */
export function compareOrder(
  a: number | undefined,
  b: number | undefined,
): number {
  const left = a ?? Number.MAX_SAFE_INTEGER;
  const right = b ?? Number.MAX_SAFE_INTEGER;
  return left - right;
}
