/**
 * Linearly interpolated percentile, q in [0, 1]. TypeScript port of
 * 02-retrieval-eval's `bootstrap.percentile`: same interpolation, same
 * edge behavior, so a p50 here means the same thing it means there.
 */
export function percentile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) {
    throw new Error("cannot take a percentile of an empty list");
  }
  if (!(q >= 0 && q <= 1)) {
    throw new Error(`q must be in [0, 1], got ${q}`);
  }
  const position = q * (sortedValues.length - 1);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  const fraction = position - below;
  return sortedValues[below]! * (1 - fraction) + sortedValues[above]! * fraction;
}
