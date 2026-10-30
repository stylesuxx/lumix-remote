import { PageModel } from '/page-model.js';
import { StreamDecoder } from '/stream-codec.js';

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element]),
);

// Captures, viewer, capture state and RAW downloads; app.js renders it.
const model = new PageModel();

let browsedFolder = null;

// The Refresh button shows a spinner while a full read runs.
let fullStatusReads = 0;
let isCameraBusyShown = false;

const LIVE_VIEW_STALL_MILLISECONDS = 2000;
const STREAM_RECONNECT_MILLISECONDS = 2000;
let lastFrameAt = 0;
let shownFrameUrl = null;
// Width over height of the last decoded frame; the image reports 0x0 while
// the next frame decodes.
let liveFrameRatio = 4 / 3;
let streamAbort = null;

// The shot and file the viewer last loaded, so a re-render keeps its zoom.
let shownViewerImage = null;

const AUTO_PREVIEW_STORAGE_KEY = 'lumix-remote.auto-preview';

// The last focus point placed on the live view, as fractions of the frame.
const FOCUS_POINT_STORAGE_KEY = 'lumix-remote.focus-point';
let focusPoint = readStoredFocusPoint();

const RAW_BADGE_TITLES = { saved: 'RAW saved', downloading: 'RAW downloading', 'on-camera': 'RAW on the camera, not downloaded' };

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
  model.isCameraConnected = status.isConnected;
  renderConnection();
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
    select.disabled = !setting.isEditable || model.isCameraBusy;
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
  if (!model.isCameraBusy) {
    refreshStatus({ isFull: true });
  }
});
elements.refreshButton.addEventListener('click', () => refreshStatus({ isFull: true }));

// Rendering the model
function render() {
  renderConnection();
  renderCaptureState();
  renderSession();
  renderViewer();
}

function renderConnection() {
  if (model.isCameraConnected === null) {
    return;
  }

  elements.connection.textContent = model.isCameraConnected ? 'connected' : 'camera not reachable';
  elements.connection.className = `chip ${model.isCameraConnected ? 'is-ok' : 'is-error'}`;
}

function renderCaptureState() {
  elements.captureButton.disabled = model.isCaptureBlocked;
  const overlayText = model.captureOverlayText;
  elements.captureOverlay.hidden = overlayText === null;
  elements.captureOverlay.textContent = overlayText ?? '';

  // Settings lock while the camera fires and re-read once it is free.
  if (model.isCameraBusy && !isCameraBusyShown) {
    for (const select of elements.settings.querySelectorAll('select')) {
      select.disabled = true;
    }
  }

  isCameraBusyShown = model.isCameraBusy;
}

function renderSession() {
  if (document.activeElement !== elements.directoryInput) {
    elements.directoryInput.value = model.directory;
  }

  const { camera } = model;
  elements.cameraInfo.textContent = camera
    ? [camera.model, camera.firmware && `firmware ${camera.firmware}`].filter(Boolean).join(' · ')
    : '';

  const raw = model.rawSummary;
  elements.downloads.textContent = raw.downloading ? `RAW downloading: ${raw.downloading}` : '';
  const percent = raw.percent === null ? '' : ` ${raw.percent}%`;
  if (raw.downloading > 0) {
    elements.downloadRawButton.textContent = `Downloading RAW (${raw.downloading} left)${percent}`;
    elements.downloadRawButton.title = raw.progressName ? `${raw.progressName}.RW2${percent}` : '';
  } else {
    elements.downloadRawButton.textContent = raw.onCamera ? `Download RAW (${raw.onCamera})` : 'Download RAW';
    elements.downloadRawButton.title = 'Download the RAW files of every shot in this folder that has none yet';
  }

  elements.downloadRawButton.classList.toggle('is-working', raw.downloading > 0);
  // Stays clickable while downloading when more shots still have their RAW on the card.
  elements.downloadRawButton.disabled = raw.onCamera === 0;

  renderGallery();
}

// The RAW badge is solid once the RAW is saved, outlined while it downloads
// and dashed while it is only on the card.
function rawBadge(entry) {
  if (entry.raw === null) {
    return null;
  }

  const badge = document.createElement('span');
  badge.className = `raw-badge is-${entry.raw}`;
  badge.textContent = 'RAW';
  badge.title = RAW_BADGE_TITLES[entry.raw];

  return badge;
}

function renderGallery() {
  const { captures } = model;
  elements.captureCount.textContent = captures.length ? `(${captures.length})` : '';
  elements.gallery.replaceChildren(
    ...captures.map((entry) => {
      const item = document.createElement('div');
      item.className = 'gallery-item';
      item.classList.toggle('is-new', entry.name === model.newestCaptureName);

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'gallery-open';
      open.title = entry.files.join(', ') || entry.name;
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.src = `/files/preview/${encodeURIComponent(entry.name)}.jpg?v=${Math.round(entry.modifiedAt)}`;
      image.alt = entry.name;
      open.append(image);
      open.addEventListener('click', () => {
        model.openViewer(entry.name);
        render();
      });

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

function renderViewer() {
  const entry = model.viewedCapture;
  elements.viewer.hidden = entry === null;
  document.body.classList.toggle('is-viewer-open', entry !== null);
  if (entry === null) {
    shownViewerImage = null;
    return;
  }

  elements.viewerTitle.textContent = entry.name;
  elements.viewerFiles.textContent = model.viewerFilesText(entry);
  elements.viewerDelete.disabled = !model.isViewedCaptureListed;
  elements.viewerRaw.hidden = entry.raw !== 'on-camera';

  const imageKey = `${entry.name}/${entry.fullImage ?? ''}`;
  if (imageKey === shownViewerImage) {
    return;
  }

  const isNewShot = shownViewerImage?.split('/')[0] !== entry.name;
  shownViewerImage = imageKey;
  if (isNewShot) {
    elements.viewerCanvas.classList.remove('is-zoomed');
    elements.viewerImage.src = `/files/preview/${encodeURIComponent(entry.name)}.jpg`;
  }

  // The full JPEG replaces the preview once loaded, so the preview shows meanwhile.
  if (entry.fullImage) {
    const fullImage = new Image();
    const fullSource = `/files/original/${encodeURIComponent(entry.fullImage)}`;
    fullImage.addEventListener('load', () => {
      if (shownViewerImage === imageKey) {
        elements.viewerImage.src = fullSource;
      }
    });
    fullImage.src = fullSource;
  }
}

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
  elements.live.classList.remove('is-empty');

  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }
}

function handleServerEvent(event) {
  const effects = model.applyServerEvent(event);
  render();
  for (const effect of effects) {
    switch (effect.type) {
      case 'toast': {
        showToast(effect.message);
      } break;

      case 'refresh-status': {
        refreshStatus({ isFull: true });
      } break;
    }
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

// Reconnects after the stream ends or fails, until the signal aborts. Every
// connection starts with a hello event carrying the current state.
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
  }
});
window.addEventListener('pagehide', closeStream);

setInterval(() => {
  const isStalled = Date.now() - lastFrameAt >= LIVE_VIEW_STALL_MILLISECONDS;
  elements.liveMessage.hidden = !isStalled;
  elements.liveMessageText.textContent = model.liveViewMessage;
  elements.showLiveViewButton.hidden = !model.isLiveViewPausedForRaw;
  elements.live.classList.toggle('is-stale', isStalled);
  placeFocusMarker();
}, 500);

elements.live.addEventListener('load', () => {
  liveFrameRatio = elements.live.naturalWidth / elements.live.naturalHeight;
});

// The area a frame of imageRatio occupies inside its object-fit: contain box.
function imageContentBox(image, imageRatio) {
  const box = image.getBoundingClientRect();
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

  const frame = imageContentBox(elements.live, liveFrameRatio);
  const viewportBox = elements.viewport.getBoundingClientRect();
  elements.focusMarker.style.left = `${frame.left - viewportBox.left + focusPoint.x * frame.width}px`;
  elements.focusMarker.style.top = `${frame.top - viewportBox.top + focusPoint.y * frame.height}px`;
  elements.focusMarker.hidden = false;
}

window.addEventListener('resize', placeFocusMarker);

elements.viewport.addEventListener('click', async (event) => {
  if (model.isCameraBusy) {
    return;
  }

  const frame = imageContentBox(elements.live, liveFrameRatio);
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
// background. The choice is remembered in this browser; each capture keeps
// the choice it started with.
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
  if (model.isCaptureBlocked) {
    return;
  }

  try {
    await api('POST', '/api/capture', { isAutoPreview: elements.autoPreview.checked });
  } catch (error) {
    showToast(`Capture failed: ${error.message}`);
  }
}
elements.captureButton.addEventListener('click', capture);

// RAW downloads
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

elements.showLiveViewButton.addEventListener('click', async (event) => {
  // The viewport behind the button sets the focus point on click.
  event.stopPropagation();
  try {
    await api('POST', '/api/live-view/show');
  } catch (error) {
    showToast(`Could not show live view: ${error.message}`);
  }
});

// Deleting; the server pushes the updated listing, which also moves the viewer.
async function deleteCapture(name) {
  if (!window.confirm(`Delete ${name} from this folder? The camera's card keeps its copy.`)) {
    return;
  }

  try {
    model.applySession(await api('DELETE', `/api/captures/${encodeURIComponent(name)}`));
    render();
  } catch (error) {
    showToast(`Could not delete ${name}: ${error.message}`);
  }
}

// Save folder
async function useFolder(directory) {
  model.applySession(await api('POST', '/api/session', { directory }));
  render();
}

elements.directoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await useFolder(elements.directoryInput.value);
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
    await useFolder(browsedFolder.path);
    elements.folderDialog.close();
  } catch (error) {
    showToast(error.message);
  }
});

// Viewer
function closeViewer() {
  model.closeViewer();
  render();
}

// Captures are listed newest first, so "previous" is one further down the list.
function stepViewer(offset) {
  model.stepViewer(offset);
  render();
}

// Zooms to 100% around the clicked point so focus can be checked.
function toggleZoom(event) {
  const canvas = elements.viewerCanvas;
  const image = elements.viewerImage;
  if (canvas.classList.contains('is-zoomed')) {
    canvas.classList.remove('is-zoomed');
    return;
  }

  const box = imageContentBox(image, image.naturalWidth / image.naturalHeight);
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
elements.viewerPrevious.addEventListener('click', () => stepViewer(1));
elements.viewerNext.addEventListener('click', () => stepViewer(-1));
elements.viewerDelete.addEventListener('click', () => {
  if (model.isViewedCaptureListed) {
    deleteCapture(model.viewerName);
  }
});

elements.viewerRaw.addEventListener('click', () => {
  if (model.isViewedCaptureListed) {
    downloadRaw([model.viewerName]);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
    return;
  }

  if (elements.folderDialog.open) {
    return;
  }

  const isViewerOpen = model.viewerName !== null;
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
        stepViewer(isLeft ? 1 : -1);
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
