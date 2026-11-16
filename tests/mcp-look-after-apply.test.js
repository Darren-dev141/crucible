import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

// A mesh local volume binds to a part by name, so the preview's part list must follow every topology change: a volume
// that names a node added by scene_apply failed scene_look with a stale list. The scene has no floor, since a new automatic ground
// rebuilds the whole renderer and hides the bug.

async function startServer(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-look-after-apply-'));
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'look-after-apply-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    await runtime.close?.();
  });
  return client;
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box' }],
  materials: [{ id: 'matte', color: [0.7, 0.7, 0.7] }],
  nodes: [{ id: 'crate', geometry: 'box', material: 'matte' }],
  camera: { eye: [0, 2, 5], target: [0, 0, 0] },
};

test('scene_look draws a mesh volume bound to a node that scene_apply added after the first look', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const created = await call(client, 'scene_create', { recipe });
  await call(client, 'scene_look', {});
  const applied = await call(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: created.revision, operations: [
    { type: 'add-node', node: { id: 'cloud', geometry: 'box', material: 'matte', translation: [0, 0.2, 0], scale: [0.8, 0.8, 0.8], visible: false } },
    { type: 'set-environment', environment: { localVolumes: [{ shape: 'mesh', part: 'cloud', density: 1 }] } },
  ] });
  assert.ok(applied.revision > created.revision);
  await call(client, 'scene_look', { sessionId: created.sessionId });
});
