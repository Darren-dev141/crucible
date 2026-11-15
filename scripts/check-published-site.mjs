// Checks what the site serves, not what the repository holds. Run `npm run prepare:release` first.
// 1. Every link in public/llms.txt and in the guides copied into public/ must point at a file the site serves
//    (public/ plus the pages in site/). `check-links.mjs` resolves against docs/, so it misses a guide the build never copies.
// 2. Every `/releases/<x.y.z>/` link in those files and in the learn pages must name a release that public/releases holds.
// Usage: node scripts/check-published-site.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { publishedDocuments } from './published-documents.mjs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_ORIGIN = 'https://crucible.codepawl.com';
const linkPattern = /(?:\]\(|href="|src="|\]: ?)(<?[^)"#\s>]+)/g;
const releaseLinkPattern = /\/releases\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\//g;
const externalPattern = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// Written by `prepare:release`, `build-pack-index.mjs` or the browser at run time, and an example path in the guide.
const generatedLinks = new Set(['/release.json', '/changelog.json', '/api-reference.json', './main.js']);

function publishedTextFiles(root) {
  const publicFolder = join(root, 'public');
  const files = [];
  const llms = join(publicFolder, 'llms.txt');
  if (existsSync(llms)) files.push(llms);
  // Only the guides the build copies count. A stale file from an older build is not served.
  for (const name of ['guide.md', 'gltf.md', ...publishedDocuments.filter((document) => document.endsWith('.md'))]) {
    const path = join(publicFolder, name);
    if (existsSync(path)) files.push(path);
  }
  return files;
}

// Example code in a guide names paths of the reader's own project, such as /src/main.js.
function withoutCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

function learnPages(root) {
  const folder = join(root, 'docs/learn');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith('.md')).map((name) => join(folder, name));
}

// The path a link asks the site for, or null for a link that leaves the site.
function sitePathOf(link) {
  if (link.startsWith(SITE_ORIGIN)) return link.slice(SITE_ORIGIN.length) || '/';
  if (externalPattern.test(link)) return null;
  return link;
}

function siteServes(root, sitePath) {
  const clean = sitePath.split('?')[0];
  if (clean === '/' || clean === '') return true;
  const relativePath = clean.replace(/^\/+/, '');
  const candidates = [relativePath, `${relativePath}.html`, `${relativePath}.md`];
  // Pages in site/ are built to the output root under their own file name.
  return candidates.some((candidate) => existsSync(join(root, 'public', candidate)) || existsSync(join(root, 'site', candidate)));
}

export function findUnpublishedLinks(root) {
  const missing = [];
  for (const file of publishedTextFiles(root)) {
    const text = withoutCodeBlocks(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(linkPattern)) {
      const link = match[1].replace(/^</, '');
      if (generatedLinks.has(link)) continue;
      const sitePath = sitePathOf(link);
      if (sitePath === null) continue;
      // A relative link is read from the served location of the file, which is the site root.
      const served = sitePath.startsWith('/') ? sitePath : posix.normalize(`/${sitePath}`);
      if (served.startsWith('/..') || !siteServes(root, served)) missing.push(`${relative(root, file)} -> ${link}`);
    }
  }
  return missing;
}

export function findMissingReleaseLinks(root) {
  const missing = [];
  const files = [...publishedTextFiles(root), ...learnPages(root)];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(releaseLinkPattern)) {
      if (!existsSync(join(root, 'public/releases', match[1]))) missing.push(`${relative(root, file)} -> /releases/${match[1]}/ is not in public/releases`);
    }
  }
  return missing;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (!existsSync(join(root, 'public/release.json'))) {
    console.error('public/release.json is missing. Run `npm run prepare:release` first.');
    process.exit(1);
  }
  const problems = [...findUnpublishedLinks(root), ...findMissingReleaseLinks(root)];
  console.log(`${problems.length} links to files or releases the site does not serve`);
  for (const problem of problems) console.log(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
