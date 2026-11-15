/** Returns `value` when it is one of `allowed`, else throws a RangeError naming the field and the valid values. */
export function requireOneOf(format, field, value, allowed) {
  if (allowed.includes(value)) return value;
  throw new RangeError(`${format} ${field} is ${value}; use ${allowed.join(', ')}.`);
}
