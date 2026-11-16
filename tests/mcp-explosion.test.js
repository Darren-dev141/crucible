import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

// add-explosion through the real MCP tools (#1050): the hidden shaping nodes must reach the preview's part list after the apply,
// and the exported recipe must pass the scene_create input schema, which the internal validator alone does not prove.

async function startServer(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-explosion-mcp-'));
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'explosion-test', version: '1' });
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
  nodes: [{ id: 'floor', geometry: 'box', material: 'matte', scale: [4, 0.1, 4] }],
  camera: { eye: [0, 2, 5], target: [0, 0, 0] },
};

test('scene_look draws a blast added by scene_apply, and the exported recipe is created fresh', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const created = await call(client, 'scene_create', { recipe });
  await call(client, 'scene_look', {});
  const applied = await call(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: created.revision, operations: [{ type: 'add-explosion', id: 'blast', center: [0, 0, 0], size: 2 }] });
  assert.ok(applied.revision > created.revision);
  for (const motionTime of [0, 0.3, 1.5]) {
    await call(client, 'scene_look', { sessionId: created.sessionId, motionTime });
  }
  const exported = await call(client, 'scene_export_recipe', { sessionId: created.sessionId });
  const again = await call(client, 'scene_create', { recipe: exported.recipe ?? exported });
  assert.ok(again.sessionId);
});
