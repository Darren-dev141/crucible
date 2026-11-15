import test from 'node:test';
import assert from 'node:assert/strict';
import { frameControlScript, frameControlStyle } from '../src/docs-live-controls.js';

function fakeElement(properties = {}) {
  const classNames = new Set();
  const attributes = { ...(properties.attributes ?? {}) };
  return {
    dataset: {},
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    classList: { add: name => classNames.add(name), contains: name => classNames.has(name) },
    listeners: {},
    children: [],
    addEventListener(type, listener) { this.listeners[type] = listener; },
    after(sibling) { this.sibling = sibling; },
    before(sibling) { this.previous = sibling; },
    append(...nodes) { this.children.push(...nodes); },
    getAttribute: name => attributes[name] ?? null,
    setAttribute: (name, value) => { attributes[name] = value; },
    attributes,
    parentElement: null,
    ...properties,
  };
}

function runControlScript({ sliderProperties, fixedSlider = false }) {
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
  const computeStyle = element => {
    const sliderIsFixed = element === slider && fixedSlider && slider.style.position !== 'static';
    const builtPanelIsFixed = element.style.cssText?.includes('position:fixed');
    return { position: sliderIsFixed || builtPanelIsFixed ? 'fixed' : 'absolute' };
  };
  const run = new Function('document', 'getComputedStyle', 'MutationObserver', 'addEventListener', frameControlScript);
  run(frame, computeStyle, FakeObserver, () => {});
  const added = [{ addedNodes: [{}] }];
  observerCallback(added);
  return { slider, panel, created, observerCallback, added };
}

test('the shared slider script adds a value label and a fill that follow the slider', () => {
  const { slider, panel, created } = runControlScript({ sliderProperties: { min: '3', max: '64', step: '1', value: '12' } });
  const value = created[0];
  assert.equal(slider.dataset.crucibleRange, 'true');
  assert.equal(value.textContent, '12');
  assert.equal(slider.style.values['--fill'], '15%');
  assert.ok(panel.classList.contains('crucible-control'));

  slider.value = '64';
  slider.listeners.input();
  assert.equal(value.textContent, '64');
  assert.equal(slider.style.values['--fill'], '100%');
  assert.equal(slider.attributes['aria-valuetext'], '64');
});

test('the value label is linked to the slider', () => {
  const { slider, created } = runControlScript({ sliderProperties: { min: '0', max: '1', step: '0.05', value: '0.35' } });
  assert.ok(slider.id.length > 0, 'the slider gets an id');
  assert.equal(created[0].htmlFor, slider.id);
  assert.equal(created[0].textContent, '0.35');
});

test('running the script again adds no second label', () => {
  const { created, observerCallback, added } = runControlScript({ sliderProperties: { min: '0', max: '10', step: '1', value: '4' } });
  observerCallback(added);
  observerCallback(added);
  assert.equal(created.length, 1);
});

test('a slider that is itself fixed is moved into a fixed panel that carries its name', () => {
  const { slider, created } = runControlScript({
    sliderProperties: { min: '0', max: '1', step: '0.1', value: '0.5', attributes: { 'aria-label': 'Trees per square metre' } },
    fixedSlider: true,
  });
  const panel = created.find(element => element.style.cssText?.includes('position:fixed'));
  assert.ok(panel, 'a panel is built');
  assert.ok(panel.children.includes(slider), 'the slider moves into the panel');
  assert.equal(slider.style.position, 'static');
  assert.ok(panel.classList.contains('crucible-panel'));
  assert.ok(panel.children.some(child => child.textContent === 'Trees per square metre'), 'the panel shows the slider name');
});

test('the shared slider style covers hover and focus-visible in both browser engines', () => {
  for (const selector of [':hover::-webkit-slider-thumb', ':hover::-moz-range-thumb', ':focus-visible::-webkit-slider-thumb', ':focus-visible::-moz-range-thumb']) {
    assert.ok(frameControlStyle.includes(selector), `missing ${selector}`);
  }
  assert.equal(frameControlStyle.split('{').length, frameControlStyle.split('}').length, 'braces must balance');
});
