// Races a promise against a deadline that names the step that stalled, so a test that waits on a page fails in seconds with a reason (#1354).
export const STEP_DEADLINE_MILLISECONDS = 15000;

export async function withDeadline(promise, step, milliseconds = STEP_DEADLINE_MILLISECONDS) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The test stalled for ${milliseconds} ms waiting for ${step}.`)), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Starts a page function that waits for something (a promise on the page) and returns a promise for its value. The deadline covers the page
// promise itself, since evaluateHandle only resolves once the page promise settles, not the instant jsonValue() runs.
export function watchPage(page, step, pageFunction, argument, milliseconds = STEP_DEADLINE_MILLISECONDS) {
  const watching = withDeadline(
    page.evaluateHandle(pageFunction, argument).then(handle => handle.jsonValue()),
    step,
    milliseconds,
  );
  // The caller awaits it later; a rejection before then must not count as unhandled.
  watching.catch(() => {});
  return watching;
}
