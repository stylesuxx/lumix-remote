import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CameraError,
  LumixCamera,
  parseContentResources,
  parseLensRange,
  parseMenu,
  parseResult,
} from '../src/server/lumix.js';
import { extractJpeg } from '../src/server/liveview.js';
import { BROWSE_RESPONSE, BUSY, contentInfo, OK, scriptedCamera as fakeCamera } from './support/fake-camera.js';

test('reads results from XML and comma separated answers', () => {
  assert.equal(parseResult(OK), 'ok');
  assert.equal(parseResult('err_reject,0,0'), 'err_reject');
  assert.equal(parseResult('ok,2304/256,768/256'), 'ok');
});

test('requests access under the device name', async () => {
  const { camera, queries } = fakeCamera((query) => (query.startsWith('mode=accctrl') ? 'ok,G70-7448F4,remote,encrypted' : OK));
  await camera.requestAccess();
  assert.deepEqual(queries, [
    'mode=accctrl&type=req_acc&value=0&value2=lumix-remote',
    'mode=setsetting&type=device_name&value=lumix-remote',
  ]);
});

test('reports when the camera stops and starts answering', async () => {
  let isReachable = true;
  const camera = new LumixCamera({
    fetchFunction: async () => {
      if (!isReachable) {
        throw new TypeError('fetch failed');
      }

      return new Response(OK);
    },
  });
  const changes = [];
  camera.on('connection', (isConnected) => changes.push(isConnected));

  await camera.getState();
  await camera.getState();
  isReachable = false;
  await assert.rejects(camera.getState());
  await assert.rejects(camera.getState());
  isReachable = true;
  await camera.getState();

  assert.deepEqual(changes, [true, false, true]);
});

test('parses lens limits', () => {
  assert.deepEqual(parseLensRange('ok,2304/256,768/256,3072/256,-1536/256,0,off,30,30,on,128/1024,on'), {
    maximumAperture: 9,
    minimumAperture: 3,
    maximumTime: 12,
    minimumTime: -6,
  });
  assert.equal(parseLensRange('err_busy'), null);
});

test('parses menu items with their enabled state and value', () => {
  const menu = parseMenu(
    '<item id="menu_item_id_afmode" enable="yes" value="1area" />' +
      '<item id="menu_item_id_afmode_pinpoint" enable="no" />',
  );
  assert.deepEqual(menu.get('afmode'), { isEnabled: true, value: '1area' });
  assert.deepEqual(menu.get('afmode_pinpoint'), { isEnabled: false, value: null });
});

test('classifies the resources of a card item', () => {
  const resources = parseContentResources(BROWSE_RESPONSE);
  assert.deepEqual(
    resources.map((resource) => [resource.kind, resource.extension, resource.number]),
    [
      ['original', 'JPG', '1100135'],
      ['thumbnail', 'JPG', '1100135'],
      ['preview', 'JPG', '1100135'],
      ['original', 'RW2', '1100135'],
    ],
  );
});

test('captureImage waits through err_busy until the image count rises', async () => {
  let contentInfoCalls = 0;
  const { camera, queries } = fakeCamera((query) => {
    if (query === 'mode=get_content_info') {
      contentInfoCalls++;
      if (contentInfoCalls === 1) {
        return contentInfo(77);
      }
      if (contentInfoCalls === 2) {
        return BUSY;
      }
      return contentInfo(contentInfoCalls === 3 ? 77 : 78);
    }
    if (query.startsWith('POST')) {
      return BROWSE_RESPONSE;
    }
    return OK;
  });

  const resources = await camera.captureImage();

  assert.equal(resources.length, 4);
  assert.ok(queries.includes('mode=camcmd&value=capture'));
  assert.ok(queries.indexOf('mode=camcmd&value=recmode') < queries.indexOf('mode=camcmd&value=capture'));
  assert.equal(queries.at(-2), 'mode=get_content_info');
  assert.match(queries.at(-1), /^POST .*:60606\/Server0\/CDS_control$/);
});

test('captureImage cancels the shot after its timeout', async () => {
  const { camera, queries } = fakeCamera((query) => (query === 'mode=get_content_info' ? contentInfo(5) : OK));
  await assert.rejects(camera.captureImage({ timeoutMilliseconds: 20 }), (error) => error.result === 'timeout');
  assert.equal(queries.at(-1), 'mode=camcmd&value=capture_cancel');
});

test('commands raise the camera error result', async () => {
  const { camera } = fakeCamera(() => 'err_reject,0,0');
  await assert.rejects(camera.driveFocus('near', 'normal'), (error) => error instanceof CameraError && error.result === 'err_reject');
});

test('setSetting refuses values that would alter the query', async () => {
  const { camera, queries } = fakeCamera(() => OK);
  await assert.rejects(camera.setSetting('iso', '200&mode=capture'));
  await camera.setSetting('aspectratio', '16:9');
  assert.deepEqual(queries, ['mode=setsetting&type=aspectratio&value=16:9']);
});

test('extracts the JPEG after the live view header', () => {
  const header = Buffer.alloc(32 + 156);
  header.writeUInt16BE(156, 30);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.deepEqual(extractJpeg(Buffer.concat([header, jpeg])), jpeg);
  assert.equal(extractJpeg(Buffer.alloc(10)), null);
});

test('download fails when data stops arriving and leaves no partial file', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lumix-remote-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  // Sends one chunk, then nothing; like fetch, aborting the signal errors the body.
  const fetchFunction = async (url, options) => {
    const stalledBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
        options.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(stalledBody);
  };
  const camera = new LumixCamera({ fetchFunction });

  await assert.rejects(
    camera.download('http://camera/DO1.RW2', path.join(directory, 'P1.RW2'), { idleTimeoutMilliseconds: 50 }),
    (error) => error.result === 'timeout',
  );
  assert.deepEqual(await readdir(directory), []);
});

test('download writes the complete file', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lumix-remote-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const camera = new LumixCamera({ fetchFunction: async () => new Response('raw bytes') });

  await camera.download('http://camera/DO1.RW2', path.join(directory, 'P1.RW2'));

  assert.equal(await readFile(path.join(directory, 'P1.RW2'), 'utf8'), 'raw bytes');
  assert.deepEqual(await readdir(directory), ['P1.RW2']);
});

test('a resumable download continues from its partial file', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lumix-remote-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'P1.RW2.part'), 'raw ');
  const ranges = [];
  const progress = [];
  const camera = new LumixCamera({
    fetchFunction: async (url, options) => {
      ranges.push(options.headers.Range);
      return new Response('bytes', { status: 206, headers: { 'Content-Range': 'bytes 4-8/9' } });
    },
  });

  await camera.download('http://camera/DO1.RW2', path.join(directory, 'P1.RW2'), {
    isResumable: true,
    onProgress: (receivedBytes, totalBytes) => progress.push([receivedBytes, totalBytes]),
  });

  assert.deepEqual(ranges, ['bytes=4-']);
  assert.deepEqual(progress.at(-1), [9, 9]);
  assert.equal(await readFile(path.join(directory, 'P1.RW2'), 'utf8'), 'raw bytes');
});
