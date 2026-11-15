// A node:test reporter for coding agents: one line per failing test (file, test name, first assertion message),
// then one count line. The full TAP goes to a log file, so an agent never rereads a long trace.
// Environment: CRUCIBLE_TEST_LOG names the TAP log to mention, CRUCIBLE_TEST_FAILURES_JSON names a file that receives
// every failure as JSON (the mutation check reads it).
import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const MAX_LISTED_FAILURES = 10;
const MAX_MESSAGE_LENGTH = 160;

function firstMessageLine(error) {
  const original = error?.cause ?? error;
  const text = String(original?.message ?? error?.message ?? 'no message');
  const line = text.split('\n').find(candidate => candidate.trim()) ?? 'no message';
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : line;
}

// A suite or parent test fails only because a child failed; the child carries the reason.
function isRealFailure(event) {
  return event.details?.type !== 'suite' && event.details?.error?.failureType !== 'subtestsFailed';
}

export function describeFailure(event, folder = process.cwd()) {
  const file = event.file ? relative(folder, event.file).replace(/\\/g, '/') : 'unknown file';
  return { file, name: event.name, message: firstMessageLine(event.details?.error) };
}

export function buildCompactReport({ failures, passCount, failCount, logPath }) {
  const lines = failures.slice(0, MAX_LISTED_FAILURES).map(failure => `FAIL ${failure.file} :: ${failure.name} :: ${failure.message}`);
  if (failures.length > MAX_LISTED_FAILURES) {
    lines.push(`... ${failures.length - MAX_LISTED_FAILURES} more failures, see the log`);
  }
  const logNote = logPath ? ` (full TAP: ${logPath})` : '';
  lines.push(`${failCount === 0 ? 'PASS' : 'FAILED'}: ${passCount} passed, ${failCount} failed${logNote}`);
  return lines;
}

export default async function* compactReporter(source) {
  const failures = [];
  let passCount = 0;
  let failCount = 0;
  for await (const event of source) {
    if (event.type === 'test:pass' && event.data.details?.type !== 'suite') passCount += 1;
    if (event.type === 'test:fail' && isRealFailure(event.data)) {
      failCount += 1;
      failures.push(describeFailure(event.data));
    }
  }
  if (process.env.CRUCIBLE_TEST_FAILURES_JSON) {
    writeFileSync(process.env.CRUCIBLE_TEST_FAILURES_JSON, JSON.stringify(failures));
  }
  yield `${buildCompactReport({ failures, passCount, failCount, logPath: process.env.CRUCIBLE_TEST_LOG }).join('\n')}\n`;
}
