// Fingerprints what a source tree draws, with no GPU: the shader text for a fixed list of scene configs and the look defaults.
// The pull request check (#1802) compares the fingerprint of the base with the one of the head. When every hash matches, a
// change to a look file (shader, light, material, post, fog, sky...) cannot change a pixel through shader text or a default,
// so the pull request gets `look:identical` instead of `hold:look-approval`. The rule and the config list: CONTRIBUTING.md#look-changes.
//
// Usage:
//   node scripts/look-fingerprint.mjs --root <tree>                          print the fingerprint of <tree>/src
//   node scripts/look-fingerprint.mjs --base <tree> --head <tree> [--out f]  fingerprint both, print { lookIdentical, changed }
// Each tree is read in its own child process, so one tree never sees the modules of the other. A config that throws is
// recorded as `error: <message>`, so the same failure on both sides still compares equal and a new failure counts as a change.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FINGERPRINT_VERSION = 1;
const HASH_LENGTH = 16;

// The same name rule as `lookNamePattern` in pr-metadata-check.mjs, kept here as a source file filter for the sweep.
const LOOK_FILE_PATTERN = /(^|[-_/.])(shaders?|glsl|lights?|lighting|materials?|environment|shadows?|tone|tonemap|fog|sky|post|bloom|ssao|taa|exposure)(?=$|[-_/.])/i;

// Modules that register shader code on import but may not match the name rule. Missing ones (an older tree) are skipped.
const REGISTERING_MODULES = [
  'shaders.js', 'post.js', 'post-steps.js', 'fog-shader.js', 'explosion-shader.js', 'lighting-pass-shader.js', 'liquid-shader.js',
  'material-layer-shaders.js', 'material-snippet.js', 'subsurface-shader.js', 'toon-shader.js', 'world-material-shader.js',
  'splat-shader.js', 'light-shapes.js', 'light-linking.js', 'cascaded-shadows.js', 'irradiance-grid.js', 'reflection-probes.js',
  'water-reflection.js', 'mesh-blend.js', 'morph.js', 'skinning.js', 'environment.js', 'view-transform-shader.js',
];

// The post program configs: steps on and off, fog, sky, and the local volume kinds with and without motion.
const POST_STEP_CONFIGS = {
  'post/none': [],
  'post/finish': ['finish'],
  'post/bloom': ['bloom', 'finish'],
  'post/transparent-occlusion': ['transparent', 'occlusion', 'bloom', 'finish'],
  'post/fog': ['volume', 'finish'],
  'post/fog-sky': ['volume', 'sky', 'finish'],
  'post/fog-field-detail-lights': ['volume', 'sky', 'field', 'detail', 'lights', 'finish'],
  'post/explosion': ['explosion', 'finish'],
};
// A module that needs the browser (window, document) cannot load in Node: it has no shader text to read, so it is not a change.
const BROWSER_ONLY_ERROR = /(window|document|navigator|self) is not defined/;
const LOCAL_VOLUME_KINDS = ['grid', 'shape', 'both'];

function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH);
}

function attempt(producer) {
  try {
    return hashText(String(producer()));
  } catch (error) {
    return `error: ${error.message.split('\n')[0].slice(0, 120)}`;
  }
}

function listSourceFiles(sourceRoot) {
  return readdirSync(sourceRoot).filter(name => name.endsWith('.js')).sort();
}

async function importQuietly(sourceRoot, fileName, imported) {
  try {
    imported[fileName] = await import(pathToFileURL(join(sourceRoot, fileName)).href);
  } catch (error) {
    imported[fileName] = { importError: error.message.split('\n')[0].slice(0, 120) };
  }
}

function canonical(value) {
  if (typeof value === 'function') return 'fn';
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}[${Array.from(value).join(',')}]`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${key}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

// Every exported UPPER_CASE constant of the look files, merged by name so that moving a constant to another file changes nothing.
function collectDefaults(imported, lookFiles) {
  const defaults = {};
  for (const fileName of lookFiles) {
    for (const [name, value] of Object.entries(imported[fileName] ?? {})) {
      if (/^[A-Z][A-Z0-9_]*$/.test(name) && typeof value !== 'function') defaults[`constant/${name}`] = hashText(canonical(value));
    }
  }
  return defaults;
}

// Every exported GLSL string of the look files as one sorted list, so a moved or renamed shader string changes nothing.
function collectExportedShaders(imported, lookFiles) {
  const sources = new Set();
  for (const fileName of lookFiles) {
    for (const value of Object.values(imported[fileName] ?? {})) {
      if (typeof value === 'string' && /#version|void main\s*\(/.test(value)) sources.add(value);
    }
  }
  return [...sources].sort();
}

function registeredCode(registry) {
  if (!registry) return 'no registry';
  return [...registry.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([feature, code]) => `${feature}=${canonical(code)}`).join('\n');
}

function postConfigs(post) {
  const configs = {};
  if (!post?.createPostFragment) return { 'post/unavailable': 'error: no createPostFragment' };
  const kindSteps = kind => (post.localVolumeKindSteps ? post.localVolumeKindSteps(kind) : []);
  for (const [name, steps] of Object.entries(POST_STEP_CONFIGS)) configs[name] = attempt(() => post.createPostFragment(steps));
  configs['post/default'] = attempt(() => post.postFragment);
  configs['post/local-none'] = attempt(() => post.createPostFragment(['finish']));
  for (const kind of LOCAL_VOLUME_KINDS) {
    for (const motion of [false, true]) {
      const steps = ['local', 'finish', ...kindSteps(kind), ...(motion && post.GRID_MOTION_STEP ? [post.GRID_MOTION_STEP] : [])];
      const suffix = `${kind}${motion ? '-motion' : ''}`;
      configs[`post/local-${suffix}`] = attempt(() => post.createPostFragment(steps));
      configs[`post/local-fog-${suffix}`] = attempt(() => post.createPostFragment(['volume', 'sky', 'lights', ...steps]));
      configs[`composite/local-${suffix}`] = attempt(() => post.createLocalVolumeCompositeFragment(motion, kind));
    }
  }
  configs['sky/fragment'] = attempt(() => post.skyFragment);
  configs['bloom/fragment'] = attempt(() => post.bloomFragment);
  return configs;
}

function materialConfigs(shaders) {
  const configs = {};
  if (!shaders?.createFragmentShader) return { 'material/unavailable': 'error: no createFragmentShader' };
  const features = shaders.SHADER_FEATURES ?? [];
  configs['material/fragment-all'] = attempt(() => shaders.createFragmentShader());
  configs['material/vertex-all'] = attempt(() => shaders.createVertexShader());
  configs['material/fragment-none'] = attempt(() => shaders.createFragmentShader([]));
  configs['material/vertex-none'] = attempt(() => shaders.createVertexShader([]));
  configs['material/fragment-default'] = attempt(() => shaders.fragmentShader);
  configs['material/vertex-default'] = attempt(() => shaders.vertexShader);
  for (const feature of features) {
    configs[`material/fragment-${feature}`] = attempt(() => shaders.createFragmentShader([feature]));
    configs[`material/vertex-${feature}`] = attempt(() => shaders.createVertexShader([feature]));
  }
  if (shaders.createDepthVertexShader) configs['shadow/depth-vertex'] = attempt(() => shaders.createDepthVertexShader());
  if (shaders.createDepthFragmentShader) configs['shadow/depth-fragment'] = attempt(() => shaders.createDepthFragmentShader());
  configs['shadow/depth-default'] = attempt(() => `${shaders.depthVertexShader}\n${shaders.depthFragmentShader}`);
  if (shaders.liquidFragmentSource) configs['material/liquid'] = attempt(() => shaders.liquidFragmentSource());
  return configs;
}

/** The fingerprint of one source tree: { version, configs, defaults }. Each value is a hash or `error: <message>`. */
export async function fingerprintTree(treeRoot) {
  const sourceRoot = join(resolve(treeRoot), 'src');
  const allFiles = listSourceFiles(sourceRoot);
  const lookFiles = allFiles.filter(fileName => LOOK_FILE_PATTERN.test(fileName));
  const imported = {};
  const importOrder = [...new Set([...REGISTERING_MODULES.filter(name => allFiles.includes(name)), ...lookFiles])];
  for (const fileName of importOrder) await importQuietly(sourceRoot, fileName, imported);

  const importErrors = Object.entries(imported).filter(([, exports]) => exports.importError && !BROWSER_ONLY_ERROR.test(exports.importError)).map(([name, exports]) => `${name}: ${exports.importError}`);
  const registry = await import(pathToFileURL(join(sourceRoot, 'shader-registry.js')).href).catch(() => null);
  const configs = {
    ...postConfigs(imported['post.js']),
    ...materialConfigs(imported['shaders.js']),
    'registered/feature-code': attempt(() => registeredCode(registry?.registeredFeatureCode)),
    'exported/glsl': attempt(() => collectExportedShaders(imported, importOrder).join('\n\u0000\n')),
    'import/errors': attempt(() => importErrors.join('\n')),
  };
  return { version: FINGERPRINT_VERSION, configs, defaults: collectDefaults(imported, importOrder) };
}

/** Which config or default names differ between two fingerprints (a name present on one side only counts). */
export function compareFingerprints(base, head) {
  if (!base || !head || base.version !== FINGERPRINT_VERSION || head.version !== FINGERPRINT_VERSION) {
    return { lookIdentical: false, changed: ['fingerprint-unavailable'] };
  }
  const changed = [];
  for (const section of ['configs', 'defaults']) {
    const names = new Set([...Object.keys(base[section]), ...Object.keys(head[section])]);
    for (const name of [...names].sort()) {
      if (base[section][name] !== head[section][name]) changed.push(name);
    }
  }
  return { lookIdentical: changed.length === 0, changed };
}

function fingerprintInChild(treeRoot) {
  const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--root', treeRoot], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
  });
  return JSON.parse(output);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main(args) {
  const rootOption = readOption(args, '--root');
  if (rootOption) {
    process.stdout.write(JSON.stringify(await fingerprintTree(rootOption)));
    return;
  }
  const baseOption = readOption(args, '--base');
  const headOption = readOption(args, '--head');
  if (!baseOption || !headOption) {
    throw new Error('Pass --root <tree>, or --base <tree> --head <tree> [--out <file>].');
  }
  let result;
  try {
    result = compareFingerprints(fingerprintInChild(baseOption), fingerprintInChild(headOption));
  } catch (error) {
    result = { lookIdentical: false, changed: ['fingerprint-failed'], error: error.message.split('\n')[0] };
  }
  const text = JSON.stringify(result, null, 2);
  const outputPath = readOption(args, '--out');
  if (outputPath) writeFileSync(outputPath, `${text}\n`);
  process.stdout.write(`${text}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
