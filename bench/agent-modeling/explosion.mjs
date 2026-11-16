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
  // add-explosion adds its own sparks, dust, rubble and scorch nodes, so the check is on the floor and pillars, not a part count.
  { kind: 'nodesUnchanged', nodes: EXPLOSION_START.nodes, label: 'floor and pillars untouched' },
  { kind: 'blastInside', halfWidth: 2.5, label: 'blast between the pillars' },
  { kind: 'toolCalled', tool: 'scene_look' },
];
