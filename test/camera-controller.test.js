import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { CameraBusyError, CameraController } from '../src/server/camera-controller.js';
import { UnknownSettingError } from '../src/server/settings.js';
import { BROWSE_RESPONSE, contentInfo, OK, scriptedCamera, settingValue } from './support/fake-camera.js';

// Stands in for the UDP live view and records what it was asked to do.
class RecordingLiveView extends EventEmitter {
  latestFrame = null;
  calls = [];
  async start() {
    this.calls.push('start');
  }
  async stop() {
    this.calls.push('stop');
  }
  async restart() {
    this.calls.push('restart');
  }
  close() {}
}

// A promise the test resolves by hand, to hold a camera answer back.
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// A camera with 77 images that gains one after the capture command.
function cardCamera({ onQuery = async () => {} } = {}) {
  let count = 77;
  return scriptedCamera(async (query) => {
    await onQuery(query);
    if (query === 'mode=camcmd&value=capture') {
      count += 1;
    }
    if (query === 'mode=get_content_info') {
      return contentInfo(count);
    }
    if (query.startsWith('POST')) {
      return BROWSE_RESPONSE;
    }
    if (query === 'mode=getsetting&type=focusmode') {
      return settingValue('focusmode', 'afc');
    }
    if (query === 'mode=getstate') {
      return '<camrply><result>ok</result><state><batt>3/3</batt><cammode>rec</cammode></state></camrply>';
    }
    return OK;
  });
}

function controllerFor(camera) {
  const liveView = new RecordingLiveView();
  return { controller: new CameraController({ camera, liveView, liveViewStopDelayMilliseconds: 0 }), liveView };
}

test('a capture pauses live view, shoots and returns to record mode', async () => {
  const { camera, queries } = cardCamera();
  const { controller, liveView } = controllerFor(camera);
  controller.addViewer(() => {});

  const resources = await controller.capture();

  assert.equal(resources.length, 4);
  assert.deepEqual(liveView.calls, ['start', 'stop', 'start']);
  assert.ok(queries.indexOf('mode=camcmd&value=capture') > 0);
  assert.equal(queries.at(-1), 'mode=camcmd&value=recmode');
  assert.equal(controller.isCapturing, false);
});

test('status reads during a capture answer without asking the camera', async () => {
  const shutter = gate();
  const { camera, queries } = cardCamera({
    onQuery: (query) => (query === 'mode=camcmd&value=capture' ? shutter.promise : undefined),
  });
  const { controller } = controllerFor(camera);
  await controller.readStatus();

  const capture = controller.capture();
  await new Promise((resolve) => setImmediate(resolve));
  const queriesBefore = queries.length;
  const status = await controller.readStatus({ isFull: true });

  assert.equal(status.isCapturing, true);
  assert.equal(queries.length, queriesBefore);
  shutter.open();
  await capture;
});

test('commands during a capture are rejected as busy', async () => {
  const shutter = gate();
  const { camera } = cardCamera({
    onQuery: (query) => (query === 'mode=camcmd&value=capture' ? shutter.promise : undefined),
  });
  const { controller } = controllerFor(camera);

  const capture = controller.capture();
  await assert.rejects(controller.focusAt(500, 500), CameraBusyError);
  await assert.rejects(controller.capture(), CameraBusyError);
  shutter.open();
  await capture;
});

test('a capture waits for a command already sent', async () => {
  const focusAnswer = gate();
  const { camera, queries } = cardCamera({
    onQuery: (query) => (query.includes('type=focus') ? focusAnswer.promise : undefined),
  });
  const { controller } = controllerFor(camera);

  const drive = controller.driveFocus('near', 'normal');
  const capture = controller.capture();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!queries.includes('mode=camcmd&value=playmode'));

  focusAnswer.open();
  await Promise.all([drive, capture]);
  assert.ok(queries.indexOf('mode=camcmd&value=playmode') > queries.findIndex((query) => query.includes('type=focus')));
});

test('a focus point switches the AF mode to touch AF before touching', async () => {
  const { camera, queries } = cardCamera();
  const { controller } = controllerFor(camera);

  await controller.focusAt(250, 750);

  assert.deepEqual(queries, [
    'mode=setsetting&type=afmode&value=touch_af',
    'mode=camctrl&type=touch&value=250/750&value2=on',
    'mode=camctrl&type=touch&value=250/750&value2=off',
  ]);
});

test('changing the live view size restarts live view', async () => {
  const { camera } = cardCamera();
  const { controller, liveView } = controllerFor(camera);

  await controller.applySetting('liveviewsize', 'qvga');
  await controller.applySetting('iso', '400');
  await assert.rejects(controller.applySetting('brightness', '1'), UnknownSettingError);

  assert.deepEqual(liveView.calls, ['restart']);
});

test('live view stops once the last viewer leaves', async () => {
  const { camera } = cardCamera();
  const { controller, liveView } = controllerFor(camera);

  const removeFirst = controller.addViewer(() => {});
  const removeSecond = controller.addViewer(() => {});
  removeFirst();
  removeSecond();
  removeSecond();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(liveView.calls, ['start', 'start', 'stop']);
});

test('a capture can hold live view paused until it is released', async () => {
  const { camera } = cardCamera();
  const { controller, liveView } = controllerFor(camera);
  controller.addViewer(() => {});

  await controller.capture({ isLiveViewHeld: true });
  assert.deepEqual(liveView.calls, ['start', 'stop']);

  await controller.releaseLiveView();
  assert.deepEqual(liveView.calls, ['start', 'stop', 'start']);
});
