import test from 'node:test';
import assert from 'node:assert/strict';
import { frameControlScript, frameControlStyle } from '../src/docs-live-controls.js';

function fakeElement(properties = {}) {
  const classNames = new Set();
  return {
    dataset: {},
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    classList: { add: name => classNames.add(name), contains: name => classNames.has(name) },
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    after(sibling) { this.sibling = sibling; },
    getAttribute() { return null; },
    parentElement: null,
    ...properties,
  };
}

function runControlScript(sliderProperties) {
  const body = fakeElement();
  const panel = fakeElement({ parentElement: body });
  const slider = fakeElement({ parentElement: panel, ...sliderProperties });
  const created = [];
  const frame = {
    body,
    documentElement: {},
    createElement: () => {
      const element = fakeElement();
      created.push(element);
      return element;
    },
    querySelectorAll: () => ({ forEach: callback => callback(slider) }),
  };
  let observerCallback = null;
  class FakeObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
  }
  const run = new Function('document', 'getComputedStyle', 'MutationObserver', 'addEventListener', 'setInterval', frameControlScript);
  run(frame, () => ({ position: 'absolute' }), FakeObserver, () => {}, () => {});
  observerCallback();
  return { slider, panel, value: created[0] };
}

test('the shared slider script adds a value label and a fill that follow the slider', () => {
  const { slider, panel, value } = runControlScript({ min: '3', max: '64', step: '1', value: '12' });
  assert.equal(slider.dataset.crucibleRange, 'true');
  assert.equal(value.textContent, '12');
  assert.equal(slider.style.values['--fill'], '15%');
  assert.ok(panel.classList.contains('crucible-control'));

  slider.value = '64';
  slider.listeners.input();
  assert.equal(value.textContent, '64');
  assert.equal(slider.style.values['--fill'], '100%');
});

test('the shared slider script shows as many decimals as the step has', () => {
  const { value } = runControlScript({ min: '0', max: '1', step: '0.05', value: '0.35' });
  assert.equal(value.textContent, '0.35');
});

test('the shared slider style covers hover and focus-visible in both browser engines', () => {
  for (const selector of [':hover::-webkit-slider-thumb', ':hover::-moz-range-thumb', ':focus-visible::-webkit-slider-thumb', ':focus-visible::-moz-range-thumb']) {
    assert.ok(frameControlStyle.includes(selector), `missing ${selector}`);
  }
  assert.equal(frameControlStyle.split('{').length, frameControlStyle.split('}').length, 'braces must balance');
});
