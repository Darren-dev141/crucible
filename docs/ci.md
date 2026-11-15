# CI

`test.yml` runs on every pull request and is called by `publish.yml`, so a release runs the same checks as the pull request that produced it.

## Jobs

All jobs start at once.

| Job | What it runs |
| --- | --- |
| `audit` | `npm audit --audit-level=high` |
| `size` | `npm run size` and `npm run tool-cost` against the pull request base (pull requests only; a release has no base) |
| `unit` (12 shards balanced by measured time, `scripts/shard-test-files.mjs` and `config/test-timings.json`) | `npm run build:lib`, then `npm run test:coverage` on one twelfth of the test files; uploads its lcov and per-file timings |
| `coverage` | merges the shard lcov files, writes the summary, compares with `config/coverage-baseline.json`, uploads `lcov` |
| `package` | `prepare:release`, `check:links:package`, `check:published-site`, `smoke:package`, `smoke:mcp-package` |
| `bun` | `smoke:mcp-package` with `MCP_SERVER_RUNTIME=bun`: the packed MCP server runs under bun, the way `bunx crucible-mcp` starts it |
| `test` | waits for every job above and fails unless each one succeeded. Branch protection on `main` requires this name. |

`node --test` runs each file in its own process (the Node 24 default, `--test-isolation=process`), so the unit pass is also the isolation check. `npm run test:isolated` stays as a local tool: it runs the same files four at a time and reruns a failure alone.

## A test that hangs

`npm test`, `npm run test:coverage` and `npm run test:isolated` start every test file with `--test-timeout=150000`, so a test without its own `timeout` option fails after 2.5 minutes with `test timed out after ...` and its name, instead of waiting for the 15 minute job limit. `node --test` alone does not end the file: the process stays alive while a Chrome or a dev server it started keeps a handle open. So each file also loads `scripts/test-hang-guard.mjs`, which:

- stops the file after `CRUCIBLE_TEST_FILE_LIMIT_MS` (default 660000, above the longest `timeout` a test sets), kills every child process the file started with its tree, prints `TEST FILE HUNG: <file>` and exits 1;
- kills a child a file left running when it exits normally (a child started with `detached: true` is left alone there).

`tests/test-hang-guard.test.js` proves it on `tests/fixtures/hanging-test-file.js`, a file that hangs on purpose with a child process: it fails in about 7 seconds with shortened limits, names the test and leaves no child running. A test that needs longer than 2.5 minutes sets `{ timeout: <ms> }` on itself, and one above 660 seconds also needs a higher file limit.

## Coverage

Coverage comes from Node's built-in `--experimental-test-coverage`. The `coverage` job fails when line or function coverage falls more than 0.5 points, or branch coverage more than 1.5 points, below `config/coverage-baseline.json` (branch totals move by up to about 0.8 points between runs of the same commit). Raise the baseline by editing that file; lower it only on purpose and say why in the pull request. In CI the gate runs with `--expect-shards 12` and refuses to merge unless the files are exactly `shard-1.info` to `shard-12.info`, each with source files in it. A shard that is missing, left over from another shard count, doubled or empty fails with the problems listed and "Re-run all jobs". This is what a `gh run rerun --failed` after a hung shard used to turn into a wrong total of 91.66 % (#1320); rerun all jobs instead. To reproduce locally: `npm run test:coverage -- --test-reporter=lcov --test-reporter-destination=coverage/lcov.info`, then `npm run coverage:gate -- coverage`.

## Add a job or a smoke

1. Add the job to `test.yml`: `actions/checkout`, then `./.github/actions/setup`, then your command. Pin any new action by full SHA.
2. Add its id to `needs` of the `test` job. A job left out of `needs` does not gate `main`.
3. A smoke that needs the packed archive goes in the `package` job after `prepare:release`.
