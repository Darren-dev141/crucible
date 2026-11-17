import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

// Issue 1872: planning a mesh took 2 to 5 capability calls, so one topic answers the common branches together.

async function connectClient(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'capabilities-modeling-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function ask(client, argumentsValue) {
  return client.callTool({ name: 'scene_capabilities', arguments: argumentsValue });
}

const EXPECTED_BRANCHES = ['geometries.box', 'meshEdit.set_position', 'meshEdit.inset_region', 'meshEdit.extrude_individual', 'meshEdit.extrude_face_region', 'meshEdit.boolean', 'meshEdit.uv_project'];

test('modeling holds the common mesh branches, each equal to its single topic', async context => {
  const client = await connectClient(context);
  const modeling = await ask(client, { topic: 'modeling' });
  assert.notEqual(modeling.isError, true);
  assert.equal(modeling.structuredContent.topic, 'modeling');
  assert.deepEqual(Object.keys(modeling.structuredContent.answers), EXPECTED_BRANCHES);
  for (const branch of EXPECTED_BRANCHES) {
    const single = await ask(client, { topic: branch });
    assert.deepEqual(modeling.structuredContent.answers[branch], single.structuredContent, branch);
  }
});

test('the index names modeling as a topic and points planning at it', async context => {
  const client = await connectClient(context);
  const index = await ask(client, {});
  assert.match(index.structuredContent.how, /topic "modeling"/);
  assert.ok(index.structuredContent.topics.scene.includes('modeling'));
});

test('modeling takes no branch and can sit in a topic list', async context => {
  const client = await connectClient(context);
  const branch = await ask(client, { topic: 'modeling.box' });
  assert.equal(branch.isError, true);
  assert.match(branch.content[0].text, /modeling has no branch box/);
  const listed = await ask(client, { topic: ['modeling', 'environment'] });
  assert.deepEqual(Object.keys(listed.structuredContent.answers), ['modeling', 'environment']);
});

test('concise format drops the notes inside the modeling answer', async context => {
  const client = await connectClient(context);
  const detailed = await ask(client, { topic: 'modeling', response_format: 'detailed' });
  const concise = await ask(client, { topic: 'modeling', response_format: 'concise' });
  assert.ok(JSON.stringify(concise.structuredContent).length < JSON.stringify(detailed.structuredContent).length);
  const singleConcise = await ask(client, { topic: 'meshEdit.boolean', response_format: 'concise' });
  assert.deepEqual(concise.structuredContent.answers['meshEdit.boolean'], singleConcise.structuredContent);
});
