// Shared checks for the library-level modeling operations (bevel, subdivide, loop cut, bisect, curves). The recipe layer
// bounds the same inputs, and both layers read their limits from the operation modules, so the two cannot drift apart.
// Each check names the operation, the parameter, the value that was given and what to pass instead, because agents read these errors.

function describeValue(value) {
  if (value === undefined) return 'missing';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return value === null ? 'null' : `a ${typeof value}`;
}

function rangeText(minimum, maximum, exclusiveMinimum, exclusiveMaximum) {
  const lower = `${exclusiveMinimum ? 'above' : 'from'} ${minimum}`;
  return maximum === undefined ? lower : `${lower} ${exclusiveMaximum ? 'and below' : 'to'} ${maximum}`;
}

function failure(operation, name, value, expectation, example) {
  const ErrorType = typeof value === 'number' ? RangeError : TypeError;
  return new ErrorType(`${operation}: ${name} was ${describeValue(value)}; pass ${expectation}, such as ${example}.`);
}

/** A finite number inside the range; `example` is shown in the message when the value is refused. */
export function requireNumberInRange(operation, name, value, { minimum, maximum, exclusiveMinimum = false, exclusiveMaximum = false, example }) {
  const belowRange = exclusiveMinimum ? value <= minimum : value < minimum;
  const aboveRange = maximum !== undefined && (exclusiveMaximum ? value >= maximum : value > maximum);
  if (typeof value !== 'number' || !Number.isFinite(value) || belowRange || aboveRange) {
    throw failure(operation, name, value, `a number ${rangeText(minimum, maximum, exclusiveMinimum, exclusiveMaximum)}`, example);
  }
  return value;
}

/** A whole number inside the range, such as a segment, cut or level count. */
export function requireWholeNumberInRange(operation, name, value, { minimum, maximum, example = minimum }) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw failure(operation, name, value, `a whole number from ${minimum} to ${maximum}`, example);
  }
  return value;
}

/** A point or direction of three finite numbers. */
export function requireVector3(operation, name, value, example = '[0, 0, 0]') {
  const isVector = Array.isArray(value) && value.length === 3 && value.every(component => typeof component === 'number' && Number.isFinite(component));
  if (!isVector) {
    throw new TypeError(`${operation}: ${name} was ${describeValue(value)}; pass an array of three finite numbers, such as ${example}.`);
  }
  return value;
}
