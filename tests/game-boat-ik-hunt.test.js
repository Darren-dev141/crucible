import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createAnimationClip } from '../src/animation.js';
import { createAnimationGraph, createFootPlacement, createLookAt, createPathFollower } from '../src/animation-graph.js';

const SETUP_MODULE = pathToFileURL(new URL('../src/game-setup.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;

test('a game setup whose nodes have a parent cycle answers instead of hanging', () => {
  const script = `
    import { normalizeGameSetup } from ${JSON.stringify(SETUP_MODULE)};
    const nodes = [{ id: 'hero' }, { id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }];
    const animation = { clips: {}, parameters: { speed: { type: 'number' } }, rootMotion: { bone: 'x' } };
    try {
      normalizeGameSetup({ player: { node: 'hero' }, npcs: [{ node: 'a', path: [[0, 0]], animation }] }, nodes);
    } catch (error) {
      console.log(error.message);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 8000, encoding: 'utf8' });
  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'normalizeGameSetup never returned');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Invalid array length/, 'a parent cycle must not grow the descendant walk without bound');
});

function walkGraph() {
  const walk = createAnimationClip({
    duration: 1,
    loop: true,
    tracks: [{ target: 'Root', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 2] }] }],
  });
  return createAnimationGraph({
    rootMotion: { bone: 'Root' },
    clips: { walk },
    parameters: { speed: { type: 'number' } },
    layers: [{ name: 'base', states: [{ name: 'move', clip: 'walk' }] }],
  });
}

test('the follower system skips the first frame of a variable loop, whose delta is 0', () => {
  const follower = createPathFollower({ graph: walkGraph(), position: [0, 0, 0] });
  follower.follow([[0, -5]]);
  const system = follower.system();
  assert.doesNotThrow(() => system.update(0, { mode: 'variable' }));
  system.update(1 / 60, { mode: 'variable' });
  assert.ok(follower.state.speed > 0, 'the next frame steers');
});

test('a look-at and a foot placement ignore a pose time that is not a number and keep working', () => {
  const look = createLookAt({ joints: ['Neck', 'Head'], target: [1, 2, 3], smoothSeconds: 0.1 });
  look.target(0, [0, 0, 0]);
  look.target(Number.NaN, [0, 0, 0]);
  const recovered = look.target(0.05, [0, 0, 0]);
  assert.ok(recovered.every(Number.isFinite), `look-at target ${recovered}`);

  const foot = createFootPlacement({ root: 'a', middle: 'b', end: 'c', groundOffset: () => 0.2, smoothSeconds: 0.1 });
  foot.target(0, [0, 0, 0]);
  foot.target(Number.NaN, [0, 0, 0]);
  const planted = foot.target(0.05, [0, 0, 0]);
  assert.ok(planted.every(Number.isFinite), `foot target ${planted}`);
});
