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

test('the relay socket goes to the page host with a numeric port and the page protocol', () => {
  const lanPage = { protocol: 'http:', hostname: '192.168.1.20' };
  assert.equal(relaySocketUrl(lanPage, '8787', 'bob'), 'ws://192.168.1.20:8787/?id=bob');
  assert.equal(relaySocketUrl({ protocol: 'https:', hostname: 'game.example.com' }, 9000, 'a b'), 'wss://game.example.com:9000/?id=a%20b');
  assert.throws(() => relaySocketUrl(lanPage, '8787@evil.example', 'bob'), /whole number from 1 to 65535/);
  assert.throws(() => relaySocketUrl(lanPage, '0', 'bob'), /whole number from 1 to 65535/);
  assert.throws(() => relaySocketUrl(lanPage, '70000', 'bob'), /whole number from 1 to 65535/);
  assert.throws(() => relaySocketUrl(lanPage, '87.5', 'bob'), /whole number from 1 to 65535/);
});
