import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apertureLabel, formatApex, parseApex, shutterLabel, thirdStopOptions } from '../src/server/apex.js';

test('parses and formats camera APEX fractions', () => {
  assert.equal(parseApex('1963/256'), 1963 / 256);
  assert.equal(formatApex(23 / 3), '1963/256');
  assert.throws(() => parseApex('fast'));
});

test('labels shutter speeds with standard names', () => {
  assert.equal(shutterLabel(1963 / 256), '1/200');
  assert.equal(shutterLabel(12), '1/4000');
  assert.equal(shutterLabel(0), '1s');
  assert.equal(shutterLabel(-6), '60s');
});

test('labels apertures with standard f-numbers', () => {
  assert.equal(apertureLabel(1056 / 256), 'f/4');
  assert.equal(apertureLabel(3), 'f/2.8');
  assert.equal(apertureLabel(9), 'f/22');
});

test('builds third-stop options and selects the nearest to the current value', () => {
  const { options, selected } = thirdStopOptions(3, 9, apertureLabel, 1056 / 256);
  assert.equal(options.length, 19);
  assert.deepEqual(options[0], { value: '768/256', label: 'f/2.8' });
  assert.deepEqual(options.at(-1), { value: '2304/256', label: 'f/22' });
  assert.equal(selected, '1024/256');
});
