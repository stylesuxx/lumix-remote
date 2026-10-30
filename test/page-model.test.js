import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PageModel } from '../src/browser/page-model.js';

const IDLE = { isShooting: false, saving: [] };

function shot(name, overrides = {}) {
  return { name, files: [`${name}.JPG`], fullImage: `${name}.JPG`, raw: 'on-camera', modifiedAt: 0, ...overrides };
}

function session(...captures) {
  return { directory: '/photos', camera: null, captures };
}

function modelWith(...captures) {
  const model = new PageModel();
  model.applyServerEvent({ type: 'hello', capture: IDLE, session: session(...captures) });

  return model;
}

function captureStep(phase, state, extra = {}) {
  return { type: 'capture', phase, id: 1, isAutoPreview: true, state, ...extra };
}

test('auto preview opens the new shot and blocks capture until its JPEG is saved', () => {
  const model = modelWith(shot('P1'));
  const saving = { isShooting: false, saving: [{ id: 1, name: 'P2', isAutoPreview: true }] };

  model.applyServerEvent(captureStep('shooting', { isShooting: true, saving: [] }));
  assert.equal(model.captureOverlayText, 'Taking picture...');
  assert.deepEqual(model.applyServerEvent(captureStep('shot', { ...saving, saving: [{ ...saving.saving[0], name: null }] })), [
    { type: 'refresh-status' },
  ]);
  model.applyServerEvent(captureStep('preview', saving, { name: 'P2' }));

  assert.equal(model.viewerName, 'P2');
  assert.equal(model.isCaptureBlocked, true);
  assert.equal(model.captureOverlayText, 'Saving JPEG...');
  assert.equal(model.viewerFilesText(model.viewedCapture), 'saving JPEG...');
  assert.equal(model.isViewedCaptureListed, false);

  model.applyServerEvent({ type: 'session', session: session(shot('P2'), shot('P1')) });
  model.applyServerEvent(captureStep('saved', IDLE, { name: 'P2' }));
  assert.equal(model.isCaptureBlocked, false);
  assert.equal(model.viewerFilesText(model.viewedCapture), 'P2.JPG');
});

test('camera reachability follows the server and a reconnect re-reads the status', () => {
  const model = new PageModel();
  model.applyServerEvent({ type: 'hello', isCameraConnected: true, capture: IDLE, session: session() });
  assert.equal(model.isCameraConnected, true);

  assert.deepEqual(model.applyServerEvent({ type: 'connection', isConnected: false }), []);
  assert.equal(model.isCameraConnected, false);
  assert.deepEqual(model.applyServerEvent({ type: 'connection', isConnected: true }), [{ type: 'refresh-status' }]);
});

test('the live view message names why frames are missing', () => {
  const model = modelWith();
  assert.equal(model.liveViewMessage, 'Waiting for live view');

  model.applyServerEvent({ type: 'session', session: { ...session(), isLiveViewPausedForRaw: true } });
  assert.equal(model.liveViewMessage, 'Live view paused while RAW files download');

  model.applyServerEvent({ type: 'connection', isConnected: false });
  assert.equal(model.liveViewMessage, 'Camera not reachable');
});

test('a capture keeps the auto preview choice it started with', () => {
  const model = modelWith();
  const savingWithoutPreview = { isShooting: false, saving: [{ id: 1, name: 'P2', isAutoPreview: false }] };

  model.applyServerEvent(captureStep('preview', savingWithoutPreview, { name: 'P2', isAutoPreview: false }));

  assert.equal(model.viewerName, null);
  assert.equal(model.isCaptureBlocked, false);
});

test('a page that connects during a save shows it', () => {
  const model = new PageModel();
  model.applyServerEvent({
    type: 'hello',
    capture: { isShooting: false, saving: [{ id: 4, name: 'P9', isAutoPreview: true }] },
    session: session(),
  });

  assert.equal(model.isCaptureBlocked, true);
  assert.equal(model.captureOverlayText, 'Saving JPEG...');
});

test('the viewer stays on its shot when newer shots arrive, and moves on when it is deleted', () => {
  const model = modelWith(shot('P2'), shot('P1'));
  model.openViewer('P1');

  model.applySession(session(shot('P3'), shot('P2'), shot('P1')));
  assert.equal(model.viewerName, 'P1');

  model.stepViewer(-1);
  assert.equal(model.viewerName, 'P2');
  model.applySession(session(shot('P3'), shot('P1')));
  assert.equal(model.viewerName, 'P1');

  model.applySession(session(shot('P3')));
  assert.equal(model.viewerName, 'P3');
  model.applySession(session());
  assert.equal(model.viewerName, null);
});

test('RAW counts come from the listing, with progress for the file downloading', () => {
  const model = modelWith(shot('P3', { raw: 'downloading' }), shot('P2'), shot('P1', { raw: 'saved' }));
  model.applyServerEvent({ type: 'raw-progress', name: 'P3', receivedBytes: 4_500_000, totalBytes: 18_000_000 });

  assert.deepEqual(model.rawSummary, { downloading: 1, onCamera: 1, percent: 25, progressName: 'P3' });

  model.applySession(session(shot('P3', { raw: 'saved' }), shot('P2'), shot('P1', { raw: 'saved' })));
  assert.deepEqual(model.rawSummary, { downloading: 0, onCamera: 1, percent: null, progressName: null });
});

test('RAW failures become messages, and a RAW-only shot says so in the viewer', () => {
  const model = modelWith(shot('P1', { files: [], fullImage: null }));

  assert.deepEqual(model.applyServerEvent({ type: 'raw-failed', name: 'P1', error: 'timeout', retryInMilliseconds: 5000 }), [
    { type: 'toast', message: 'P1.RW2 download failed (timeout), retrying in 5 s' },
  ]);
  model.openViewer('P1');
  assert.equal(model.viewerFilesText(model.viewedCapture), 'RAW only: preview shown');
});
