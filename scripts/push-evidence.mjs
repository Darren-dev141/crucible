// Pushes pictures and clips to the `evidence-pr-<number>` branch with git plumbing, so a pull request can link them.
// The working tree, the index and HEAD are never touched: the commit is built in a temporary index file.
// Usage: node scripts/push-evidence.mjs <pr> <files...> [--remote origin] [--dry-run]
//        Each file lands at pr-<number>/<basename>. Files already on the branch stay; a file with the same name is replaced.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm']);
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const USAGE = 'Usage: node scripts/push-evidence.mjs <pr> <files...> [--remote origin] [--dry-run]';

export function parseArguments(argv) {
  const positional = [];
  let remote = 'origin';
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--remote') {
      remote = argv[index + 1];
      index += 1;
      if (!remote) throw new Error(`--remote needs a remote name, such as --remote origin. ${USAGE}`);
    } else {
      positional.push(argument);
    }
  }
  const [prText, ...files] = positional;
  return { prNumber: parsePrNumber(prText), files, remote, dryRun };
}

export function parsePrNumber(text) {
  if (!/^[1-9]\d*$/.test(String(text ?? ''))) {
    throw new Error(`The pull request number must be a positive integer, such as 1234. Got "${text ?? ''}". ${USAGE}`);
  }
  return Number(text);
}

function isInside(folder, target) {
  const relativePath = relative(folder, target);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

export function validateFiles(files, repositoryRoot) {
  if (files.length === 0) throw new Error(`Pass at least one picture or clip. ${USAGE}`);
  const allowedFolders = [realpathSync(repositoryRoot), realpathSync(tmpdir())];
  return files.map((file) => {
    const absolutePath = resolve(file);
    if (!existsSync(absolutePath)) throw new Error(`File not found: ${file}. Pass the path of an existing picture or clip.`);
    const realPath = realpathSync(absolutePath);
    if (!allowedFolders.some((folder) => isInside(folder, realPath))) {
      throw new Error(`${file} is outside the repository and the temp folder. Copy it inside the repository (artifacts/ is ignored) or into the temp folder.`);
    }
    const extension = extname(realPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      throw new Error(`${file} has type "${extension}". Pass one of: ${ALLOWED_EXTENSIONS.join(', ')}.`);
    }
    const stats = statSync(realPath);
    if (!stats.isFile()) throw new Error(`${file} is not a file. Pass a picture or clip.`);
    if (stats.size > MAX_FILE_BYTES) {
      throw new Error(`${file} is ${(stats.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit. Shrink or trim it first.`);
    }
    return { realPath, name: basename(realPath) };
  });
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd: options.cwd, env: { ...process.env, ...options.env } });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trim();
}

export function parseRemoteUrl(remoteUrl) {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  return match ? { owner: match[1], repository: match[2] } : null;
}

export function rawUrl({ owner, repository }, prNumber, name) {
  return `https://raw.githubusercontent.com/${owner}/${repository}/evidence-pr-${prNumber}/pr-${prNumber}/${name}`;
}

function fetchExistingBranchCommit(remote, branch, cwd) {
  if (!runGit(['ls-remote', '--heads', remote, `refs/heads/${branch}`], { cwd })) return null;
  runGit(['fetch', '--quiet', remote, `refs/heads/${branch}`], { cwd });
  return runGit(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd });
}

function buildEvidenceCommit({ entries, prNumber, parentCommit, cwd }) {
  const indexFolder = mkdtempSync(join(tmpdir(), 'push-evidence-'));
  const env = { GIT_INDEX_FILE: join(indexFolder, 'index') };
  try {
    if (parentCommit) runGit(['read-tree', parentCommit], { cwd, env });
    for (const { realPath, name } of entries) {
      const blob = runGit(['hash-object', '-w', '--', realPath], { cwd });
      runGit(['update-index', '--add', '--cacheinfo', `100644,${blob},pr-${prNumber}/${name}`], { cwd, env });
    }
    const tree = runGit(['write-tree'], { cwd, env });
    const parentArguments = parentCommit ? ['-p', parentCommit] : [];
    return runGit(['commit-tree', tree, ...parentArguments, '-m', `Add evidence for PR #${prNumber}`], { cwd });
  } finally {
    rmSync(indexFolder, { recursive: true, force: true });
  }
}

export function pushEvidence({ prNumber, files, remote = 'origin', dryRun = false, cwd = process.cwd() }) {
  const repositoryRoot = runGit(['rev-parse', '--show-toplevel'], { cwd });
  const entries = validateFiles(files.map((file) => resolve(cwd, file)), repositoryRoot);
  const branch = `evidence-pr-${prNumber}`;
  const repository = parseRemoteUrl(runGit(['remote', 'get-url', remote], { cwd }));
  const links = entries.map(({ name }) => ({
    name,
    url: repository ? rawUrl(repository, prNumber, name) : null,
  }));
  if (!dryRun) {
    const parentCommit = fetchExistingBranchCommit(remote, branch, cwd);
    const commit = buildEvidenceCommit({ entries, prNumber, parentCommit, cwd });
    runGit(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`], { cwd, env: { SKIP_PREFLIGHT: '1' } });
  }
  return { branch, links, dryRun };
}

export function formatReport({ branch, links, dryRun }) {
  const heading = dryRun ? `Dry run: would push to ${branch}` : `Pushed to ${branch}`;
  const lines = [heading];
  for (const { name, url } of links) {
    if (!url) {
      lines.push(`${name} (remote is not on GitHub, so there is no raw URL)`);
      continue;
    }
    lines.push(url, `![${name}](${url})`);
  }
  return lines.join('\n');
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  try {
    console.log(formatReport(pushEvidence(parseArguments(process.argv.slice(2)))));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
