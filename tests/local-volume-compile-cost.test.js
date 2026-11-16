import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostFragment, GRID_MOTION_STEP } from '../src/post.js';
import '../src/fog-shader.js';

// The driver builds every inlined copy of a function, and the build of a grid volume's post program took 23 to 32 s on ANGLE d3d11
// when the in-scatter light was inlined with both the grid and the shape profile at each call site (#1768). These tests pin the
// shape of the source that made it fast, since a build time cannot be measured in a unit test.

const sources = {
  still: createPostFragment(['local']),
  motion: createPostFragment(['local', GRID_MOTION_STEP]),
};

function occurrences(source, text) {
  return source.split(text).length - 1;
}

for (const [name, source] of Object.entries(sources)) {
  test(`the ${name} local volume program keeps one copy of the in-scatter light per kind of volume`, () => {
    for (const kind of ['Grid', 'Shape']) {
      assert.equal(occurrences(source, `localVolumeInScatter${kind}(nearest, position, direction)`), 1, `${kind} march calls its in-scatter once`);
      assert.equal(occurrences(source, `localVolumeSkyLight${kind}(index, position)`), 1);
      assert.equal(occurrences(source, `localVolumeDepth${kind}(index, position, lightDirection`), 1);
    }
    assert.equal(occurrences(source, 'localVolumeInScatter(nearest'), 0, 'no march uses the generic copy');
  });

  test(`the ${name} program's grid copy never reads the shape profile and the shape copy never reads the grid profile`, () => {
    const gridCopy = source.slice(source.indexOf('vec3 localVolumeDepthGrid('), source.indexOf('vec3 localVolumeDepthShape('));
    const shapeCopy = source.slice(source.indexOf('vec3 localVolumeDepthShape('), source.indexOf('// The share of the key light a surface keeps'));
    assert.ok(gridCopy.length > 0 && shapeCopy.length > 0);
    assert.doesNotMatch(gridCopy, /localVolumeShapeProfile|localVolumeProfile\(/);
    assert.doesNotMatch(shapeCopy, /localVolumeGridProfile|localVolumeProfile\(/);
  });

  test(`the ${name} program gathers the sky light in one loop over the five directions`, () => {
    for (const kind of ['Grid', 'Shape']) {
      assert.equal(occurrences(source, `localVolumeDepthOnce${kind}(index, position, direction)`), 1);
      assert.equal(occurrences(source, `localVolumeDepthOnce${kind}(index, position, vec3(`), 0, 'no direction is spelled out as its own call');
    }
  });

  test(`the ${name} program stays under its source size`, () => {
    assert.ok(source.length < 32500, `${source.length} characters`);
  });
}
