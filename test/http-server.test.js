import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { CameraBusyError } from '../src/server/camera-controller.js';
import { createHttpServer } from '../src/server/http-server.js';
import { CameraError } from '../src/server/lumix.js';
import { InvalidCaptureError } from '../src/server/session.js';
import { StreamDecoder } from '../src/shared/stream-codec.js';
import { UnknownSettingError } from '../src/server/settings.js';

// Stand-ins that record calls; behaviour lives in the overrides.
function fakeController(overrides = {}) {
  return {
    isCapturing: false,
    camera: Object.assign(new EventEmitter(), { isConnected: true }),
    calls: [],
    addViewer: () => () => {},
    readStatus: async ({ isFull }) => ({ isConnected: true, isFull }),
    applySetting: async () => {},
    focusAt: async function (x, y) {
      this.calls.push(['focusAt', x, y]);
    },
    driveFocus: async () => null,
    ...overrides,
  };
}

const SNAPSHOT = { directory: '/photos', captures: [], camera: { model: 'DMC-G70', firmware: '2.2' } };

function fakeCaptureFlow({ isShooting = false } = {}) {
  return Object.assign(new EventEmitter(), {
    state: { isShooting, saving: [] },
    started: [],
    start(options) {
      if (this.state.isShooting) {
        throw new CameraBusyError('a capture is in progress');
      }
      this.started.push(options);

      return this.started.length;
    },
  });
}

function fakeSession(overrides = {}) {
  return Object.assign(new EventEmitter(), {
    directory: '/photos',
    snapshot: async () => SNAPSHOT,
    deleted: [],
    async deleteCapture(name) {
      if (name.includes('/')) {
        throw new InvalidCaptureError(`invalid capture name: ${name}`);
      }
      this.deleted.push(name);
    },
    downloadRaw: async (names) => names ?? ['P1'],
    resolveFile: () => null,
    ...overrides,
  });
}

async function serve(
  context,
  { controller = fakeController(), captureFlow = fakeCaptureFlow(), session = fakeSession() } = {},
) {
  const server = createHttpServer({ controller, captureFlow, session });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    controller,
    captureFlow,
    session,
    request: async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}

test('maps errors to status codes', async (context) => {
  const controller = fakeController({
    applySetting: async (key) => {
      if (key === 'unknown') {
        throw new UnknownSettingError('unknown setting unknown');
      }
      if (key === 'busy') {
        throw new CameraBusyError('a capture is in progress');
      }
      throw new CameraError('mode=setsetting: err_reject', 'err_reject');
    },
  });
  const { request } = await serve(context, { controller });

  assert.equal((await request('POST', '/api/settings', { key: 'unknown', value: 1 })).status, 400);
  assert.equal((await request('POST', '/api/settings', { key: 'busy', value: 1 })).status, 409);
  const rejected = await request('POST', '/api/settings', { key: 'iso', value: 1 });
  assert.equal(rejected.status, 502);
  assert.equal(rejected.body.result, 'err_reject');
  assert.equal((await request('POST', '/api/settings', '{not json')).status, 400);
  assert.equal((await request('GET', '/nowhere')).status, 404);
});

test('clamps focus points to the frame and reads full status on request', async (context) => {
  const { request, controller } = await serve(context);

  await request('POST', '/api/focus/point', { x: -20, y: 1500 });
  const status = await request('GET', '/api/status?full');

  assert.deepEqual(controller.calls, [['focusAt', 0, 1000]]);
  assert.equal(status.body.isFull, true);
});

test('starts captures with their auto preview choice and rejects one while the camera fires', async (context) => {
  const { request, captureFlow } = await serve(context);

  assert.deepEqual((await request('POST', '/api/capture', { isAutoPreview: true })).body, { id: 1 });
  assert.deepEqual((await request('POST', '/api/capture', {})).body, { id: 2 });
  assert.deepEqual(captureFlow.started, [{ isAutoPreview: true }, { isAutoPreview: false }]);

  const busy = await serve(context, { captureFlow: fakeCaptureFlow({ isShooting: true }) });
  assert.equal((await busy.request('POST', '/api/capture')).status, 409);
});

test('deletes captures by name and queues RAW downloads', async (context) => {
  const { request, session } = await serve(context);

  const afterDelete = await request('DELETE', '/api/captures/P1100135');
  assert.equal(afterDelete.status, 200);
  assert.deepEqual(afterDelete.body, SNAPSHOT);
  assert.equal((await request('DELETE', '/api/captures/..%2Fsecret')).status, 400);
  assert.equal((await request('DELETE', '/api/captures/%E0%A4%A')).status, 400);
  assert.deepEqual(session.deleted, ['P1100135']);
  assert.deepEqual((await request('POST', '/api/raw', { names: ['P2'] })).body, { queued: ['P2'] });
  assert.deepEqual((await request('POST', '/api/raw', {})).body, { queued: ['P1'] });
});

test('serves the page and the shared stream codec', async (context) => {
  const { base, request } = await serve(context);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const codec = await fetch(`${base}/stream-codec.js`);
  assert.match(await codec.text(), /export class StreamDecoder/);
  const model = await fetch(`${base}/page-model.js`);
  assert.match(await model.text(), /export class PageModel/);
  assert.equal((await request('GET', '/files/original/..%2F..%2Fetc%2Fpasswd')).status, 400);
  assert.equal((await request('GET', '/api/directories?path=/no/such/folder')).status, 400);
});

test('a stream opens with the current state and carries later events', async (context) => {
  const { base, session, captureFlow, controller } = await serve(context);
  const abort = new AbortController();
  context.after(() => abort.abort());

  const response = await fetch(`${base}/stream`, { signal: abort.signal });
  const reader = response.body.getReader();
  const decoder = new StreamDecoder();
  const events = [];
  const readEvents = async (count) => {
    while (events.length < count) {
      const { value } = await reader.read();
      events.push(...decoder.push(value).map((part) => part.event));
    }
  };

  await readEvents(1);
  captureFlow.emit('capture', { phase: 'shot', id: 1, isAutoPreview: false, state: { isShooting: false, saving: [] } });
  session.emit('change');
  session.emit('change');
  await readEvents(3);
  // The two changes above produce one listing, so the next event is this capture step.
  captureFlow.emit('capture', { phase: 'saved', id: 1, isAutoPreview: false, state: { isShooting: false, saving: [] } });
  controller.camera.emit('connection', false);
  await readEvents(5);

  assert.deepEqual(events.map((event) => event.phase ?? event.type), ['hello', 'shot', 'session', 'saved', 'connection']);
  assert.deepEqual(events[0], {
    type: 'hello',
    isCameraConnected: true,
    capture: { isShooting: false, saving: [] },
    session: SNAPSHOT,
  });
  assert.deepEqual(events[2], { type: 'session', session: SNAPSHOT });
  assert.deepEqual(events[4], { type: 'connection', isConnected: false });
});
