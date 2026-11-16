// A courtyard and a request for a blast, with no hint of the operation's name. The agent has to find add-explosion in the
// scene_apply operations (or scene_capabilities), place the blast inside the courtyard and look at it. The grader reads the
// exported recipe: a grid volume whose frames are the explosion-... grids, centred inside the courtyard, plus the tool
// calls the run made (scene_look at least once). No render check, so it stays cheap on CI.

const COURTYARD_HALF = 4;
const PILLAR_POSITIONS = [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]];

export const EXPLOSION_START = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'block', type: 'box', bevel: 0.01 }],
  materials: [{ id: 'stone', color: [0.62, 0.6, 0.56] }],
  nodes: [
    { id: 'floor', geometry: 'block', material: 'stone', scale: [COURTYARD_HALF * 2, 0.1, COURTYARD_HALF * 2], translation: [0, -0.05, 0] },
    ...PILLAR_POSITIONS.map(([x, z], index) => ({ id: `pillar-${index + 1}`, geometry: 'block', material: 'stone', scale: [0.5, 3, 0.5], translation: [x, 1.5, z] })),
  ],
  camera: { target: [0, 1, 0], eye: [9, 6, 9], up: [0, 1, 0], fov: 45, near: 0.1, far: 80 },
};

export const EXPLOSION_PROMPT = `You are working with the Crucible MCP tools. Units are metres and Y is up. The courtyard scene below is a square
floor, 8 m by 8 m and centred on the origin, with four pillars standing on it. Add a blast to the courtyard, somewhere on the floor between the pillars,
and look at it with scene_look. Leave the floor and the pillars as they are. When it is finished, call scene_export_recipe once: the exported recipe is what gets graded.`;

export const EXPLOSION_CHECKS = [
  { kind: 'parts', min: 5, max: 5 },
  { kind: 'blastInside', halfWidth: 2.5, label: 'blast between the pillars' },
  { kind: 'toolCalled', tool: 'scene_look' },
];

/** The recipe add-explosion leaves for a blast at the origin: one grid volume of baked explosion-dry-1 frames (hand-written, as the other references are). */
export const EXPLOSION_SOLUTION = {
  ...structuredClone(EXPLOSION_START),
  environment: {
    localVolumes: [{
      shape: 'grid',
      frames: ['explosion-dry-1_0000.67vg', 'explosion-dry-1_0001.67vg'],
      fps: 24, loop: false,
      center: [0, 2, 0], size: [4, 4, 4],
      density: 1, absorption: [1, 1, 1], emission: [1, 0.5, 0.2], emissionStrength: 1,
      temperatureScale: 1000, blackbodyIntensity: 1, steps: 48, castShadow: true, lightsScene: true,
    }],
  },
};
