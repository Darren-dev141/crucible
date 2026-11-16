#!/usr/bin/env node
// Builds the cache key of the built Cook addon for the Cook addon job (#1800).
// The key holds everything that changes the binary: the Cook pin SHA from package-lock.json, the runner OS and architecture,
// the Rust toolchain and the build recipe. Usage: node scripts/cook-addon-cache-key.mjs <runner-os> <runner-arch> "<rustc --version>"
// It prints `pin=`, `key=` and `rustc=` lines for $GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COOK_LOCK_ENTRY = 'node_modules/@codepawlhq/cook';

/** Bump when the way the job builds or stores the addon changes, so old entries are never restored. */
export const BUILD_RECIPE = 'cargo-release-v1';

/** The commit SHA after the `#` of the resolved git URL of Cook in package-lock.json. */
export function cookPinFromLock(lockText) {
  const entry = JSON.parse(lockText).packages?.[COOK_LOCK_ENTRY];
  const resolved = entry?.resolved;
  const pin = typeof resolved === 'string' ? /#([0-9a-f]{40})$/.exec(resolved)?.[1] : undefined;
  if (pin === undefined) {
    throw new Error(
      `package-lock.json has no 40 character commit SHA in packages["${COOK_LOCK_ENTRY}"].resolved; pin Cook to a commit SHA so the addon cache can be keyed by it.`,
    );
  }
  return pin;
}

/** `rustc 1.91.0 (f8297e351 2025-10-28)` becomes `rustc-1.91.0-f8297e351-2025-10-28`. */
export function normalizeRustcVersion(rustcVersionLine) {
  const normalized = rustcVersionLine.trim().replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-|-$/g, '');
  if (!normalized.startsWith('rustc-')) {
    throw new Error(`Expected the output of \`rustc --version\`, got "${rustcVersionLine}".`);
  }
  return normalized;
}

export function cookAddonCacheKey({ lockText, runnerOs, runnerArch, rustcVersionLine }) {
  const pin = cookPinFromLock(lockText);
  const rustc = normalizeRustcVersion(rustcVersionLine);
  return { pin, rustc, key: `cook-addon-${BUILD_RECIPE}-${runnerOs}-${runnerArch}-${rustc}-${pin}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runnerOs, runnerArch, rustcVersionLine] = process.argv.slice(2);
  if (!runnerOs || !runnerArch || !rustcVersionLine) {
    console.error('Usage: node scripts/cook-addon-cache-key.mjs <runner-os> <runner-arch> "<rustc --version output>"');
    process.exit(1);
  }
  const lockText = readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8');
  const { pin, rustc, key } = cookAddonCacheKey({ lockText, runnerOs, runnerArch, rustcVersionLine });
  console.log(`pin=${pin}\nrustc=${rustc}\nkey=${key}`);
}
