// Checks that a version bump is a complete release: CHANGELOG.md has a "## <version>" section and every changes/<issue>.md note was
// folded into it. Runs before `publish` in publish.yml (skipped when the version is already on npm); the PR-side gate is check-change-note.mjs, so npm is never published
// from a commit whose release page the later `release` job cannot build. Usage: node scripts/check-release-changelog.mjs
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseChangelogSections, readFragments } from './changelog-fragments.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Returns what is wrong with the release as one message, or null when it is complete. Pure, so tests can call it without files.
export function releaseProblem({ version, changelogText, fragmentNames }) {
  const problems = [];
  const hasSection = parseChangelogSections(changelogText).some(section => section.version === version);
  if (!hasSection) problems.push(`CHANGELOG.md has no "## ${version}" section.`);
  if (fragmentNames.length) problems.push(`changes/ still holds ${fragmentNames.length} unfolded note(s): ${fragmentNames.join(', ')}.`);
  return problems.length ? problems.join('\n') : null;
}

export const RELEASE_FIX = 'Run npm run changes:fold, edit the new CHANGELOG.md section, and commit it with the version bump (CONTRIBUTING.md#release).';

export async function readReleaseProblem(folder = root) {
  const metadata = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  const changelogText = await readFile(resolve(folder, 'CHANGELOG.md'), 'utf8');
  const fragments = await readFragments(resolve(folder, 'changes'));
  return releaseProblem({ version: metadata.version, changelogText, fragmentNames: fragments.map(fragment => fragment.name) });
}

// True when npm already serves this exact version, which means the push is not a release. publish-ci.mjs makes the same call.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

// The name and version come from package.json; both are checked before they go into the registry URL.
export function registryVersionUrl(name, version) {
  if (typeof name !== 'string' || name.length > 214 || !NPM_PACKAGE_NAME.test(name)) {
    throw new Error(`package.json "name" ${JSON.stringify(name)} is not a valid npm package name (lowercase, optional @scope/).`);
  }
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`package.json "version" ${JSON.stringify(version)} is not a semantic version such as 1.2.3.`);
  }
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
}

export async function isVersionPublished(name, version, fetchImplementation = fetch) {
  const response = await fetchImplementation(registryVersionUrl(name, version), { signal: AbortSignal.timeout(30000) });
  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`Registry version check failed: HTTP ${response.status}.`);
}

// What the publish workflow checks: Publish runs on every push to main that touches package.json, so only a version that is not on npm
// yet is a release. Returns { skipped, problem }; `skipped` carries the reason when the version is already published.
export async function readPublishReleaseProblem(folder = root, fetchImplementation = fetch) {
  const metadata = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  if (await isVersionPublished(metadata.name, metadata.version, fetchImplementation)) {
    return { skipped: `${metadata.name}@${metadata.version} is already published, so this push is not a release.`, problem: null };
  }
  return { skipped: null, problem: await readReleaseProblem(folder) };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const { skipped, problem } = await readPublishReleaseProblem();
  if (skipped) {
    console.log(`skip: ${skipped}`);
  } else if (problem) {
    console.error(`FAIL release changelog: ${problem}
     Fix: ${RELEASE_FIX}`);
    process.exit(1);
  } else {
    console.log('ok: CHANGELOG.md has a section for the package version and no changes/ notes are left.');
  }
}
