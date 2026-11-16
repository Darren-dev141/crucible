import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

// Issue 1872: Haiku called scene_capabilities 8 to 11 times for the UVs of a crate. One call must say which edit to use.

async function askCapabilities(context, topic) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-uv-one-call-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client.callTool({ name: 'scene_capabilities', arguments: { topic } });
}

test('the meshUv topic names the edit for box-like parts and covers uv_unwrap', async context => {
  const answer = (await askCapabilities(context, 'meshUv')).structuredContent;
  assert.match(answer.value.choose, /uv_project/);
  assert.match(answer.value.choose, /"mode":"cube"/);
  assert.match(answer.value.choose, /box-like/i);
  assert.match(answer.value.uv_unwrap, /areaDistortion/);
});

test('a uv branch of meshEdit carries the meshUv notes next to its fields', async context => {
  for (const branch of ['uv_project', 'uv_unwrap', 'uv_pack']) {
    const answer = (await askCapabilities(context, `meshEdit.${branch}`)).structuredContent;
    assert.equal(answer.topic, `meshEdit.${branch}`);
    assert.match(answer.uvNotes.choose, /uv_project/, branch);
    assert.ok(answer.fields, branch);
  }
});

test('a branch that is not a uv edit has no uvNotes', async context => {
  const answer = (await askCapabilities(context, 'meshEdit.bevel')).structuredContent;
  assert.equal(answer.uvNotes, undefined);
});
