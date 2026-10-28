import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseContentResources } from '../src/server/lumix.js';
import { CaptureSession, createDirectory, InvalidCaptureError, listDirectories } from '../src/server/session.js';
import { BROWSE_RESPONSE } from './support/fake-camera.js';

const RESOURCES = parseContentResources(BROWSE_RESPONSE);

async function temporaryDirectory(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lumix-remote-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A controller whose downloads write the URL as the file content.
// failDownloads(url) returns true for the downloads that should fail.
function fakeController({ failDownloads = () => false } = {}) {
  const downloaded = [];
  return {
    downloaded,
    capture: async () => RESOURCES,
    download: async (url, destinationPath, { onProgress = () => {} } = {}) => {
      downloaded.push(url);
      if (failDownloads(url)) {
        throw new Error(`cannot reach ${url}`);
      }
      onProgress(url.length, url.length);
      await writeFile(destinationPath, url);
    },
  };
}

async function sessionIn(context, controller, options = {}) {
  const directory = await temporaryDirectory(context);
  const session = new CaptureSession({ controller, directory: '.', retryDelaysMilliseconds: [0, 0], ...options });
  await session.setDirectory(directory);
  return { session, directory };
}

// Retries an assertion until it passes or a second has gone by.
async function eventually(assertion) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return assertion();
}

function nextEvent(emitter, name) {
  return new Promise((resolve) => emitter.once(name, resolve));
}

test('a capture saves the preview and JPEG and leaves the RAW on the card', async (context) => {
  const controller = fakeController();
  const { session, directory } = await sessionIn(context, controller);
  const reports = [];

  const result = await session.capture({
    onShot: () => reports.push('shot'),
    onPreview: (name) => reports.push(`preview ${name}`),
  });

  assert.deepEqual(result, { name: 'P1100135', files: ['P1100135.JPG'] });
  assert.deepEqual(reports, ['shot', 'preview P1100135']);
  assert.deepEqual((await readdir(directory)).sort(), ['.previews', 'P1100135.JPG']);
  assert.ok(!controller.downloaded.some((url) => url.endsWith('.RW2')));
  const [capture] = await session.listCaptures();
  assert.equal(capture.raw, 'on-camera');
  assert.equal(capture.fullImage, 'P1100135.JPG');
});

test('a held capture releases live view once the JPEG is saved, or saving failed', async (context) => {
  for (const isJpegFailing of [false, true]) {
    const steps = [];
    const controller = fakeController({ failDownloads: (url) => isJpegFailing && url.endsWith('DO1100135.JPG') });
    const download = controller.download;
    controller.download = async (url, destinationPath, options) => {
      steps.push(`download ${url.split('/').at(-1)}`);
      await download(url, destinationPath, options);
    };
    controller.capture = async ({ isLiveViewHeld }) => {
      steps.push(`capture held=${isLiveViewHeld}`);
      return RESOURCES;
    };
    controller.releaseLiveView = async () => {
      steps.push('release');
    };
    const { session } = await sessionIn(context, controller);

    const capture = session.capture({ isLiveViewHeld: true });
    if (isJpegFailing) {
      await assert.rejects(capture);
    } else {
      await capture;
    }

    assert.deepEqual(steps, ['capture held=true', 'download DL1100135.JPG', 'download DO1100135.JPG', 'release']);
  }
});

test('a RAW-only capture saves its preview and lists the RAW on the card', async (context) => {
  const controller = fakeController();
  controller.capture = async () => RESOURCES.filter((resource) => !(resource.kind === 'original' && resource.extension === 'JPG'));
  const { session, directory } = await sessionIn(context, controller);

  const result = await session.capture();

  assert.deepEqual(result, { name: 'P1100135', files: [] });
  assert.deepEqual(await readdir(directory), ['.previews']);
  const [capture] = await session.listCaptures();
  assert.equal(capture.raw, 'on-camera');
  assert.equal(capture.fullImage, null);
});

test('Download RAW fetches missing RAW files and marks them saved', async (context) => {
  const { session, directory } = await sessionIn(context, fakeController());
  await session.capture();
  const saved = nextEvent(session, 'raw-saved');

  assert.deepEqual(await session.downloadRaw(), ['P1100135']);
  const savedEvent = await saved;
  assert.equal(savedEvent.name, 'P1100135');
  assert.equal(savedEvent.bytes, 'http://192.168.54.1:50001/DO1100135.RW2'.length);
  assert.equal(await readFile(path.join(directory, 'P1100135.RW2'), 'utf8'), 'http://192.168.54.1:50001/DO1100135.RW2');
  assert.equal((await session.listCaptures())[0].raw, 'saved');
  assert.deepEqual(await session.downloadRaw(), []);
});

test('a failed RAW download is retried and reported', async (context) => {
  let rawAttempts = 0;
  const controller = fakeController({ failDownloads: (url) => url.endsWith('.RW2') && ++rawAttempts < 2 });
  const { session } = await sessionIn(context, controller);
  await session.capture();
  const failures = [];
  session.on('raw-failed', (failure) => failures.push(failure.retryInMilliseconds));
  const saved = nextEvent(session, 'raw-saved');

  await session.downloadRaw(['P1100135']);

  assert.equal((await saved).name, 'P1100135');
  assert.deepEqual(failures, [0]);
});

test('deleting a capture removes its files and its pending RAW', async (context) => {
  const rawStarted = Promise.withResolvers();
  const rawRelease = Promise.withResolvers();
  const controller = fakeController();
  const download = controller.download;
  controller.download = async (url, destinationPath) => {
    if (url.endsWith('.RW2')) {
      rawStarted.resolve();
      await rawRelease.promise;
    }
    await download(url, destinationPath);
  };
  const { session, directory } = await sessionIn(context, controller);
  await session.capture();

  await session.downloadRaw();
  await rawStarted.promise;
  await session.deleteCapture('P1100135');
  assert.deepEqual(session.pendingRawNames, []);
  rawRelease.resolve();

  assert.deepEqual(await session.listCaptures(), []);
  await eventually(async () => assert.deepEqual(await readdir(directory), ['.previews']));
  assert.deepEqual(await readdir(path.join(directory, '.previews')), []);
  await assert.rejects(session.deleteCapture('../outside'), InvalidCaptureError);
});

test('a repeated card number gets a timestamp in front', async (context) => {
  const { session } = await sessionIn(context, fakeController());

  await session.capture();
  const second = await session.capture();

  assert.match(second.name, /^\d{8}-\d{6}_P1100135$/);
  assert.equal((await session.listCaptures()).length, 2);
});

test('lists visible subfolders sorted by name, with the parent', async (context) => {
  const root = await temporaryDirectory(context);
  for (const name of ['beta', 'Alpha', '.hidden']) {
    await mkdir(path.join(root, name));
  }

  const listing = await listDirectories(root);

  assert.equal(listing.path, root);
  assert.equal(listing.parent, path.dirname(root));
  assert.deepEqual(listing.directories, ['Alpha', 'beta']);
});

test('creates a folder from a single name and rejects paths', async (context) => {
  const root = await temporaryDirectory(context);

  assert.equal(await createDirectory(root, ' shoot '), path.join(root, 'shoot'));
  await assert.rejects(createDirectory(root, '../escape'));
  await assert.rejects(createDirectory(root, '..'));
  await assert.rejects(createDirectory(root, ''));
});
