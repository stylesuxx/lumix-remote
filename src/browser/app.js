import { StreamDecoder } from '/stream-codec.js';

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element]),
);

let captures = [];
let viewerIndex = -1;
let isCapturing = false;
let newestCaptureName = null;
let pendingRawNames = [];
let rawProgress = null;

let browsedFolder = null;

// The Refresh button shows a spinner while a full read runs.
let fullStatusReads = 0;

const LIVE_VIEW_STALL_MILLISECONDS = 2000;
const STREAM_RECONNECT_MILLISECONDS = 2000;
let lastFrameAt = 0;
let shownFrameUrl = null;
let streamAbort = null;

const AUTO_PREVIEW_STORAGE_KEY = 'lumix-remote.auto-preview';

// The last focus point placed on the live view, as fractions of the frame.
const FOCUS_POINT_STORAGE_KEY = 'lumix-remote.focus-point';
let focusPoint = readStoredFocusPoint();

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 6000);
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }

  return data;
}

// Camera status and settings
function renderStatus(status) {
  elements.connection.textContent = status.isConnected ? 'connected' : 'camera not reachable';
  elements.connection.className = `chip ${status.isConnected ? 'is-ok' : 'is-error'}`;
  elements.battery.textContent = status.state?.battery ? `battery ${status.state.battery}` : '';
  elements.shots.textContent = status.state?.remainingShots ? `${status.state.remainingShots} shots left` : '';

  const focusMode = status.focusMode;
  elements.focusMode.textContent = focusMode ? `focus ${focusMode.toUpperCase()}` : '';
  for (const button of document.querySelectorAll('[data-focus]')) {
    button.disabled = focusMode !== 'mf';
  }

  // The short status carries no settings.
  if (!status.settings) {
    return;
  }

  renderSettings(status.settings);
  elements.readOnly.replaceChildren(
    ...(status.readOnly ?? []).flatMap((entry) => {
      const term = document.createElement('dt');
      term.textContent = entry.label;
      const description = document.createElement('dd');
      description.textContent = entry.valueLabel ?? 'n/a';

      return [term, description];
    }),
  );
}

function renderSettings(settings) {
  const focused = document.activeElement?.name;
  const rows = settings.flatMap((setting) => {
    const label = document.createElement('label');
    label.textContent = setting.label;
    label.htmlFor = `setting-${setting.key}`;

    const select = document.createElement('select');
    select.id = `setting-${setting.key}`;
    select.name = setting.key;
    select.disabled = !setting.isEditable || isCapturing;
    if (setting.value === null) {
      select.append(new Option('n/a', ''));
    }

    for (const option of setting.options) {
      select.append(new Option(option.label, option.value, false, option.value === setting.value));
    }

    select.addEventListener('change', () => changeSetting(select, setting.key));
    return [label, select];
  });
  elements.settings.replaceChildren(...rows);

  if (focused) {
    document.getElementById(`setting-${focused}`)?.focus();
  }
}

async function changeSetting(select, key) {
  select.classList.add('is-pending');
  try {
    renderStatus(await api('POST', '/api/settings', { key, value: select.value }));
  } catch (error) {
    showToast(`Could not set ${key}: ${error.message}`);
    refreshStatus({ isFull: true });
  }
}

async function refreshStatus({ isFull = false } = {}) {
  if (isFull) {
    fullStatusReads += 1;
    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add('is-loading');
  }

  try {
    renderStatus(await api('GET', isFull ? '/api/status?full' : '/api/status'));
  } catch {
    elements.connection.textContent = 'server not reachable';
    elements.connection.className = 'chip is-error';
  } finally {
    if (isFull) {
      fullStatusReads -= 1;
      if (fullStatusReads === 0) {
        elements.refreshButton.disabled = false;
        elements.refreshButton.classList.remove('is-loading');
      }
    }
  }
}

// Settings change through this page, so the camera is read on load, after
// each change and capture, and when the window regains focus (the focus lever
// and dials are changed on the camera body).
window.addEventListener('focus', () => {
  if (!isCapturing) {
    refreshStatus({ isFull: true });
  }
});
elements.refreshButton.addEventListener('click', () => refreshStatus({ isFull: true }));

// Live view and server events
// One stream carries both, since browsers allow six connections per server.
// It is read with fetch so the page knows when each frame arrives; "Waiting
// for live view" shows only while frames are missing. A hidden page closes
// its stream and catches up when it is shown again.
function showFrame(jpeg) {
  lastFrameAt = Date.now();
  const frameUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
  const previousUrl = shownFrameUrl;
  shownFrameUrl = frameUrl;
  elements.live.src = frameUrl;

  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }
}

// Handles frames and events until the stream ends.
async function readStream(signal) {
  const response = await fetch('/stream', { signal });
  const reader = response.body.getReader();
  const decoder = new StreamDecoder();
  let chunk = await reader.read();
  while (!chunk.done) {
    for (const part of decoder.push(chunk.value)) {
      if (part.frame) {
        showFrame(part.frame);
      } else {
        handleServerEvent(part.event);
      }
    }

    chunk = await reader.read();
  }
}

// Reconnects after the stream ends or fails, until the signal aborts.
async function keepStreamOpen(signal) {
  while (!signal.aborted) {
    try {
      await readStream(signal);
    } catch {
      // The server restarted, the connection dropped or the stream was closed.
    }

    if (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, STREAM_RECONNECT_MILLISECONDS));
    }
  }
}

function openStream() {
  if (streamAbort !== null) {
    return;
  }

  streamAbort = new AbortController();
  keepStreamOpen(streamAbort.signal);
}

function closeStream() {
  streamAbort?.abort();
  streamAbort = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    closeStream();
  } else {
    openStream();
    refreshStatus({ isFull: true });
    refreshSession().catch((error) => showToast(error.message));
  }
});
window.addEventListener('pagehide', closeStream);

setInterval(() => {
  elements.liveMessage.hidden = Date.now() - lastFrameAt < LIVE_VIEW_STALL_MILLISECONDS;
  placeFocusMarker();
}, 500);

// The area the image occupies inside its object-fit: contain box.
function imageContentBox(image) {
  const box = image.getBoundingClientRect();
  const imageRatio = (image.naturalWidth || 16) / (image.naturalHeight || 9);
  const boxRatio = box.width / box.height;
  const width = imageRatio > boxRatio ? box.width : box.height * imageRatio;
  const height = imageRatio > boxRatio ? box.width / imageRatio : box.height;

  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

// Focus
// The marker shows the focus point placed here last. It stays on the live
// view, dimmed after a moment, and is remembered in this browser.
function readStoredFocusPoint() {
  try {
    const stored = JSON.parse(localStorage.getItem(FOCUS_POINT_STORAGE_KEY));
    return Number.isFinite(stored?.x) && Number.isFinite(stored?.y) ? stored : null;
  } catch {
    return null;
  }
}

function storeFocusPoint() {
  try {
    localStorage.setItem(FOCUS_POINT_STORAGE_KEY, JSON.stringify(focusPoint));
  } catch {
    // Storage blocked: the point lasts until the page is reloaded.
  }
}

// Positions the marker over the focus point in the frame as currently drawn.
function placeFocusMarker() {
  if (focusPoint === null) {
    elements.focusMarker.hidden = true;
    return;
  }

  const frame = imageContentBox(elements.live);
  const viewportBox = elements.viewport.getBoundingClientRect();
  elements.focusMarker.style.left = `${frame.left - viewportBox.left + focusPoint.x * frame.width}px`;
  elements.focusMarker.style.top = `${frame.top - viewportBox.top + focusPoint.y * frame.height}px`;
  elements.focusMarker.hidden = false;
}

window.addEventListener('resize', placeFocusMarker);

elements.viewport.addEventListener('click', async (event) => {
  if (isCapturing) {
    return;
  }

  const frame = imageContentBox(elements.live);
  const x = (event.clientX - frame.left) / frame.width;
  const y = (event.clientY - frame.top) / frame.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return;
  }

  focusPoint = { x, y };
  storeFocusPoint();
  placeFocusMarker();
  elements.focusMarker.classList.remove('is-dimmed');
  try {
    await api('POST', '/api/focus/point', { x: x * 1000, y: y * 1000 });
  } catch (error) {
    showToast(`Autofocus failed: ${error.message}`);
  }

  clearTimeout(placeFocusMarker.dimTimer);
  placeFocusMarker.dimTimer = setTimeout(() => elements.focusMarker.classList.add('is-dimmed'), 1200);
});

async function driveFocus(direction, speed) {
  try {
    const { position } = await api('POST', '/api/focus/drive', { direction, speed });
    if (position && position.maximum > 0) {
      elements.focusPosition.style.width = `${(position.position / position.maximum) * 100}%`;
    }
  } catch (error) {
    showToast(`Manual focus: ${error.message}`);
  }
}

for (const button of document.querySelectorAll('[data-focus]')) {
  button.addEventListener('click', () => driveFocus(button.dataset.focus, button.dataset.speed));
}

// Capture
// With auto preview on, each new shot opens in the viewer and the next
// capture waits until its JPEG is saved. With it off, the next capture is
// possible once the camera has taken the picture, and the JPEG saves in the
// background. The choice is remembered in this browser.
function readStoredAutoPreview() {
  try {
    return localStorage.getItem(AUTO_PREVIEW_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

elements.autoPreview.checked = readStoredAutoPreview();
elements.autoPreview.addEventListener('change', () => {
  try {
    localStorage.setItem(AUTO_PREVIEW_STORAGE_KEY, elements.autoPreview.checked ? 'on' : 'off');
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
});

async function capture() {
  if (isCapturing) {
    return;
  }

  try {
    await api('POST', '/api/capture');
  } catch (error) {
    showToast(`Capture failed: ${error.message}`);
  }
}
elements.captureButton.addEventListener('click', capture);

function setCapturing(isActive, message) {
  isCapturing = isActive;
  elements.captureButton.disabled = isActive;
  elements.captureOverlay.hidden = !isActive;
  elements.captureOverlay.textContent = message ?? '';
  if (isActive) {
    for (const select of elements.settings.querySelectorAll('select')) {
      select.disabled = true;
    }
  } else {
    // Re-rendering the settings restores each dropdown's own enabled state.
    refreshStatus({ isFull: true });
  }
}

function handleCaptureEvent(event) {
  switch (event.phase) {
    case 'shooting': {
      setCapturing(true, 'Taking picture...');
    } break;

    case 'shot': {
      if (elements.autoPreview.checked) {
        setCapturing(true, 'Saving JPEG...');
      } else {
        setCapturing(false);
      }
    } break;

    case 'downloading': {
      newestCaptureName = event.name;
      if (elements.autoPreview.checked) {
        // The new capture is not in the gallery list until the JPEG is saved.
        viewerIndex = -1;
        openViewer({ name: event.name, files: [], fullImage: null, raw: null });
      } else {
        refreshSession();
      }
    } break;

    case 'done': {
      const isViewerShowingIt = !elements.viewer.hidden && elements.viewerTitle.textContent === event.name;
      if (isCapturing && elements.autoPreview.checked) {
        setCapturing(false);
      }

      refreshSession(isViewerShowingIt ? { openName: event.name } : {});
    } break;

    case 'error': {
      setCapturing(false);
      showToast(`Capture failed: ${event.error}`);
    } break;
  }
}

// RAW downloads
// A capture's RAW state: 'saved', 'downloading', 'on-camera' or null.
function rawState(entry) {
  if (entry.raw !== 'saved' && pendingRawNames.includes(entry.name)) {
    return 'downloading';
  }

  if (entry.raw === 'downloading') {
    return 'on-camera';
  }

  return entry.raw;
}

function renderPendingRaw(names) {
  pendingRawNames = names;
  elements.downloads.textContent = names.length ? `RAW downloading: ${names.length}` : '';
  elements.downloads.title = names.join(', ');

  renderGallery();
  renderViewerActions();
}

async function downloadRaw(names) {
  try {
    const { queued } = await api('POST', '/api/raw', names ? { names } : {});
    if (queued.length === 0) {
      showToast('No RAW files left to download in this folder.');
    }
  } catch (error) {
    showToast(`Download RAW failed: ${error.message}`);
  }
}
elements.downloadRawButton.addEventListener('click', () => downloadRaw(null));

function handleRawFailed(event) {
  if (event.retryInMilliseconds === null) {
    showToast(`${event.name}.RW2 could not be downloaded and was given up: ${event.error}. It is still on the camera's card.`);
  } else {
    showToast(`${event.name}.RW2 download failed (${event.error}), retrying in ${event.retryInMilliseconds / 1000} s`);
  }
}

function handleServerEvent(event) {
  switch (event.type) {
    case 'hello': {
      renderPendingRaw(event.pendingRaw);
      if (event.isCapturing) {
        setCapturing(true, 'Capture in progress...');
      }
    } break;

    case 'capture': {
      handleCaptureEvent(event);
    } break;

    case 'raw-pending': {
      renderPendingRaw(event.names);
    } break;

    case 'raw-progress': {
      rawProgress = event;
      renderGallery();
    } break;

    case 'raw-saved': {
      rawProgress = null;
      refreshSession();
    } break;

    case 'raw-failed': {
      handleRawFailed(event);
    } break;
  }
}

// Deleting
async function deleteCapture(name) {
  if (!window.confirm(`Delete ${name} from this folder? The camera's card keeps its copy.`)) {
    return;
  }

  try {
    const openName = !elements.viewer.hidden ? captures[viewerIndex]?.name : null;
    renderSession(await api('DELETE', `/api/captures/${encodeURIComponent(name)}`));
    if (openName === name) {
      if (captures.length === 0) {
        closeViewer();
      } else {
        showCapture(Math.min(viewerIndex, captures.length - 1));
      }
    }
  } catch (error) {
    showToast(`Could not delete ${name}: ${error.message}`);
  }
}

// Save folder and gallery
async function refreshSession({ openName } = {}) {
  const session = await api('GET', '/api/session');
  renderSession(session);
  if (openName && !elements.viewer.hidden) {
    const index = captures.findIndex((entry) => entry.name === openName);
    if (index >= 0) {
      showCapture(index);
    }
  }
}

function renderSession(session) {
  if (document.activeElement !== elements.directoryInput) {
    elements.directoryInput.value = session.directory;
  }

  captures = session.captures;
  elements.cameraInfo.textContent = session.camera
    ? [session.camera.model, session.camera.firmware && `firmware ${session.camera.firmware}`].filter(Boolean).join(' · ')
    : '';
  renderGallery();
  renderViewerActions();
}

// The RAW badge is solid once the RAW is saved, outlined while it downloads
// and dashed while it is only on the card.
function rawBadge(entry) {
  const state = rawState(entry);
  if (state === null) {
    return null;
  }

  const titles = { saved: 'RAW saved', downloading: 'RAW downloading', 'on-camera': 'RAW on the camera, not downloaded' };
  const badge = document.createElement('span');
  badge.className = `raw-badge is-${state}`;
  badge.textContent = 'RAW';
  badge.title = titles[state];

  return badge;
}

function renderGallery() {
  elements.captureCount.textContent = captures.length ? `(${captures.length})` : '';
  const missingRaw = captures.filter((entry) => rawState(entry) === 'on-camera').length;
  const isDownloadingRaw = pendingRawNames.length > 0;
  if (isDownloadingRaw) {
    const percent = rawProgress?.totalBytes ? ` ${Math.floor((rawProgress.receivedBytes / rawProgress.totalBytes) * 100)}%` : '';
    elements.downloadRawButton.textContent = `Downloading RAW (${pendingRawNames.length} left)${percent}`;
    elements.downloadRawButton.title = rawProgress ? `${rawProgress.name}.RW2${percent}` : pendingRawNames.join(', ');
  } else {
    elements.downloadRawButton.textContent = missingRaw ? `Download RAW (${missingRaw})` : 'Download RAW';
  }

  elements.downloadRawButton.classList.toggle('is-working', isDownloadingRaw);
  // Stays clickable while downloading when more shots still have their RAW on the card.
  elements.downloadRawButton.disabled = missingRaw === 0;

  elements.gallery.replaceChildren(
    ...captures.map((entry, index) => {
      const item = document.createElement('div');
      item.className = 'gallery-item';
      item.classList.toggle('is-new', entry.name === newestCaptureName);

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'gallery-open';
      open.title = entry.files.join(', ') || entry.name;
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.src = `/files/preview/${encodeURIComponent(entry.name)}.jpg?v=${Math.round(entry.modifiedAt)}`;
      image.alt = entry.name;
      open.append(image);
      open.addEventListener('click', () => showCapture(index));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'gallery-delete';
      remove.title = `Delete ${entry.name}`;
      remove.setAttribute('aria-label', `Delete ${entry.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => deleteCapture(entry.name));

      item.append(open, remove);
      const badge = rawBadge(entry);
      if (badge) {
        item.append(badge);
      }

      return item;
    }),
  );
}

elements.directoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    renderSession(await api('POST', '/api/session', { directory: elements.directoryInput.value }));
    elements.directoryInput.blur();
  } catch (error) {
    showToast(error.message);
  }
});

elements.galleryHandle.addEventListener('click', () => {
  elements.galleryDrawer.classList.toggle('is-open');
});

// Folder browser
async function showFolder(folderPath) {
  try {
    renderFolder(await api('GET', `/api/directories?path=${encodeURIComponent(folderPath)}`));
  } catch (error) {
    showToast(error.message);
  }
}

function renderFolder(listing) {
  browsedFolder = listing;
  elements.folderPath.textContent = listing.path;
  elements.folderUp.disabled = listing.parent === null;
  const items = listing.directories.map((name) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => showFolder(`${listing.path}/${name}`));
    item.append(button);

    return item;
  });

  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No subfolders';
    items.push(empty);
  }

  elements.folderList.replaceChildren(...items);
}

elements.browseButton.addEventListener('click', async () => {
  elements.folderNewName.value = '';
  await showFolder(elements.directoryInput.value);
  elements.folderDialog.showModal();
});

elements.folderUp.addEventListener('click', () => {
  if (browsedFolder?.parent) {
    showFolder(browsedFolder.parent);
  }
});

elements.folderHome.addEventListener('click', () => {
  if (browsedFolder) {
    showFolder(browsedFolder.home);
  }
});

elements.folderCreate.addEventListener('click', async () => {
  if (!browsedFolder || !elements.folderNewName.value.trim()) {
    return;
  }

  try {
    renderFolder(await api('POST', '/api/directories', { path: browsedFolder.path, name: elements.folderNewName.value }));
    elements.folderNewName.value = '';
  } catch (error) {
    showToast(error.message);
  }
});

elements.folderNewName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    elements.folderCreate.click();
  }
});

elements.folderChoose.addEventListener('click', async () => {
  try {
    renderSession(await api('POST', '/api/session', { directory: browsedFolder.path }));
    elements.folderDialog.close();
  } catch (error) {
    showToast(error.message);
  }
});

// Viewer
function openViewer(entry) {
  elements.viewer.hidden = false;
  document.body.classList.add('is-viewer-open');
  elements.viewerCanvas.classList.remove('is-zoomed');
  elements.viewerTitle.textContent = entry.name;
  elements.viewerFiles.textContent = entry.files.length ? entry.files.join('  ') : 'saving JPEG...';
  // The full JPEG replaces the preview once loaded, so the preview shows meanwhile.
  elements.viewerImage.src = `/files/preview/${encodeURIComponent(entry.name)}.jpg`;
  if (entry.fullImage) {
    const fullImage = new Image();
    const fullSource = `/files/original/${encodeURIComponent(entry.fullImage)}`;
    fullImage.addEventListener('load', () => {
      if (elements.viewerTitle.textContent === entry.name) {
        elements.viewerImage.src = fullSource;
      }
    });
    fullImage.src = fullSource;
  }

  renderViewerActions();
}

function viewedCapture() {
  return elements.viewer.hidden ? null : (captures[viewerIndex] ?? null);
}

function renderViewerActions() {
  const entry = viewedCapture();
  elements.viewerDelete.disabled = entry === null;
  elements.viewerRaw.hidden = entry === null || rawState(entry) !== 'on-camera';
}

function showCapture(index) {
  if (index < 0 || index >= captures.length) {
    return;
  }

  viewerIndex = index;
  openViewer(captures[index]);
}

function closeViewer() {
  elements.viewer.hidden = true;
  document.body.classList.remove('is-viewer-open');
  viewerIndex = -1;
}

// Zooms to 100% around the clicked point so focus can be checked.
function toggleZoom(event) {
  const canvas = elements.viewerCanvas;
  const image = elements.viewerImage;
  if (canvas.classList.contains('is-zoomed')) {
    canvas.classList.remove('is-zoomed');
    return;
  }

  const box = imageContentBox(image);
  const clamp = (number) => Math.min(1, Math.max(0, number));
  const relativeX = event ? clamp((event.clientX - box.left) / box.width) : 0.5;
  const relativeY = event ? clamp((event.clientY - box.top) / box.height) : 0.5;
  canvas.classList.add('is-zoomed');
  canvas.scrollLeft = relativeX * image.naturalWidth - canvas.clientWidth / 2;
  canvas.scrollTop = relativeY * image.naturalHeight - canvas.clientHeight / 2;
}

elements.viewerCanvas.addEventListener('click', toggleZoom);
elements.viewerZoom.addEventListener('click', () => toggleZoom());
elements.viewerClose.addEventListener('click', closeViewer);
// Captures are listed newest first, so "previous" is the next index.
elements.viewerPrevious.addEventListener('click', () => showCapture(viewerIndex + 1));
elements.viewerNext.addEventListener('click', () => showCapture(viewerIndex - 1));
elements.viewerDelete.addEventListener('click', () => {
  const entry = viewedCapture();
  if (entry) {
    deleteCapture(entry.name);
  }
});

elements.viewerRaw.addEventListener('click', () => {
  const entry = viewedCapture();
  if (entry) {
    downloadRaw([entry.name]);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
    return;
  }

  if (elements.folderDialog.open) {
    return;
  }

  const isViewerOpen = !elements.viewer.hidden;
  switch (event.key) {
    case ' ': {
      event.preventDefault();
      if (isViewerOpen) {
        closeViewer();
      }
      capture();
    } break;

    case 'Escape': {
      if (isViewerOpen) {
        closeViewer();
      }
    } break;

    // In the viewer the arrows step through captures (listed newest first);
    // on the live view they drive manual focus.
    case 'ArrowLeft':
    case 'ArrowRight': {
      const isLeft = event.key === 'ArrowLeft';
      if (isViewerOpen) {
        showCapture(viewerIndex + (isLeft ? 1 : -1));
      } else {
        event.preventDefault();
        driveFocus(isLeft ? 'near' : 'far', event.shiftKey ? 'fast' : 'normal');
      }
    } break;

    case 'z':
    case 'Z': {
      if (isViewerOpen) {
        toggleZoom();
      }
    } break;

    case 'Delete': {
      if (isViewerOpen) {
        elements.viewerDelete.click();
      }
    } break;
  }
});

if (!document.hidden) {
  openStream();
}
refreshStatus({ isFull: true });
refreshSession().catch((error) => showToast(error.message));
