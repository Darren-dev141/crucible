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
