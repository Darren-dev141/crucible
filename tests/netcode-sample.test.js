import assert from 'node:assert/strict';
import test from 'node:test';
import { relaySocketUrl, withInjectedLatency } from '../scripts/netcode-sample.js';

function createFakeTransport() {
  const sent = [];
  const counters = { sent: 0 };
  const state = { closed: false };
  const transport = {
    id: 'fake',
    peers: () => ['other'],
    send(peerId, message) {
      sent.push([peerId, message]);
      counters.sent += 1;
    },
    receive: () => () => {},
    close() { state.closed = true; },
    get stats() { return { ...counters }; },
  };
  return { sent, state, transport };
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('withInjectedLatency delays sends and keeps stats and peers live', async () => {
  const fake = createFakeTransport();
  const delayed = withInjectedLatency(fake.transport, 30);
  assert.equal(delayed.id, 'fake');
  assert.deepEqual(delayed.peers(), ['other']);
  assert.equal(delayed.stats.sent, 0);

  delayed.send('other', { n: 1 });
  assert.equal(fake.sent.length, 0, 'nothing leaves before the delay');
  await pause(80);
  assert.deepEqual(fake.sent, [['other', { n: 1 }]]);
  assert.equal(delayed.stats.sent, 1, 'the stats getter follows the real transport');
});

test('withInjectedLatency drops sends still waiting when the transport closes, and passes through at zero delay', async () => {
  const fake = createFakeTransport();
  const delayed = withInjectedLatency(fake.transport, 30);
  delayed.send('other', { n: 1 });
  delayed.close();
  await pause(80);
  assert.equal(fake.state.closed, true);
  assert.equal(fake.sent.length, 0);
  assert.equal(withInjectedLatency(fake.transport, 0), fake.transport);
});

test('the relay must be a ws: or wss: URL', () => {
  assert.equal(relaySocketUrl('ws://127.0.0.1:8787/', 'bob'), 'ws://127.0.0.1:8787/?id=bob');
  assert.equal(relaySocketUrl('wss://relay.example.com/play?room=1', 'a b'), 'wss://relay.example.com/play?room=1&id=a+b');
  assert.throws(() => relaySocketUrl('https://example.com/', 'bob'), /must use ws: or wss:/);
  assert.throws(() => relaySocketUrl('javascript:alert(1)', 'bob'), /must use ws: or wss:/);
  assert.throws(() => relaySocketUrl('127.0.0.1:8787', 'bob'), /must use ws: or wss:|full WebSocket URL/);
  assert.throws(() => relaySocketUrl('not a url', 'bob'), /full WebSocket URL/);
});
