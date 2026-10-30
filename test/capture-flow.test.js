import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { CameraBusyError } from '../src/server/camera-controller.js';
import { CaptureFlow } from '../src/server/capture-flow.js';

// A session whose captures advance when the test opens their gates.
function steppedSession() {
  const captures = [];
  const session = Object.assign(new EventEmitter(), {
    captures,
    capture(options) {
      const shutter = Promise.withResolvers();
      const saved = Promise.withResolvers();
      const run = (async () => {
        await shutter.promise;
        options.onShot();
        const name = await saved.promise;
        options.onPreview(name);

        return { name, files: [`${name}.JPG`] };
      })();
      captures.push({ options, shutter, saved });

      return run;
    },
  });

  return session;
}

function stepsOf(flow) {
  const steps = [];
  flow.on('capture', (step) => steps.push(step));

  return steps;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('a capture moves from shooting through saving to saved', async () => {
  const session = steppedSession();
  const flow = new CaptureFlow({ session });
  const steps = stepsOf(flow);

  const id = flow.start({ isAutoPreview: true });
  assert.equal(session.captures[0].options.isLiveViewHeld, true);
  session.captures[0].shutter.resolve();
  session.captures[0].saved.resolve('P1100135');
  await settle();

  assert.deepEqual(
    steps.map((step) => [step.phase, step.state.isShooting, step.state.saving.map((entry) => entry.name)]),
    [
      ['shooting', true, []],
      ['shot', false, [null]],
      ['preview', false, ['P1100135']],
      ['saved', false, []],
    ],
  );
  assert.deepEqual(steps.at(-1), {
    phase: 'saved', id, name: 'P1100135', files: ['P1100135.JPG'], isAutoPreview: true, state: { isShooting: false, saving: [] },
  });
});

test('the next capture can fire while earlier JPEGs are saving, but not while the camera fires', async () => {
  const session = steppedSession();
  const flow = new CaptureFlow({ session });

  flow.start({ isAutoPreview: false });
  assert.throws(() => flow.start(), CameraBusyError);
  session.captures[0].shutter.resolve();
  await settle();

  flow.start({ isAutoPreview: false });
  session.captures[1].shutter.resolve();
  await settle();

  assert.deepEqual(flow.state.saving.map((entry) => entry.id), [1, 2]);
  session.captures[1].saved.resolve('P2');
  session.captures[0].saved.resolve('P1');
  await settle();
  assert.deepEqual(flow.state, { isShooting: false, saving: [] });
});

test('a failed capture frees the camera and reports the error', async () => {
  const session = Object.assign(new EventEmitter(), {
    capture: async () => {
      throw new CameraBusyError('a capture is in progress');
    },
  });
  const flow = new CaptureFlow({ session });
  const steps = stepsOf(flow);

  flow.start();
  await settle();

  assert.deepEqual(steps.at(-1), {
    phase: 'error', id: 1, isAutoPreview: false, error: 'a capture is in progress', state: { isShooting: false, saving: [] },
  });
});
