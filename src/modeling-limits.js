// One shared check for the library-level modeling calls. The recipe layer validates the same inputs first, so this only
// stops what would hang or return NaN when a library function is called directly: NaN, missing and unbounded values.
// The limits live next to each operation, and the recipe layer imports them.
export const MAX_RESAMPLE_COUNT = 65536;


/** A finite number from `low` to `high` (a whole number when `whole`), else an error naming the call, parameter and range. */
export function requireFiniteInRange(functionName, parameter, value, low, high, whole = false) {
  const valid = [value].flat(2).every(number => Number.isFinite(number) && number >= low && number <= high && (!whole || Number.isInteger(number)));
  if (!valid) {
    throw new RangeError(`${functionName}: ${parameter} was ${value}; pass ${whole ? 'a whole number' : 'a number'} from ${low} to ${high}.`);
  }
  return value;
}
