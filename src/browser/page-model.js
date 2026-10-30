// The page's state and the rules that change it, free of the DOM so it runs
// under node --test. app.js renders it and carries out the effects it returns.

// Effects returned by applyServerEvent: { type: 'toast', message } and
// { type: 'refresh-status' } (the camera is free again, settings may be read).

const RAW_FAILED_GIVEN_UP = (event) =>
  `${event.name}.RW2 could not be downloaded and was given up: ${event.error}. It is still on the camera's card.`;
const RAW_FAILED_RETRYING = (event) =>
  `${event.name}.RW2 download failed (${event.error}), retrying in ${event.retryInMilliseconds / 1000} s`;

export class PageModel {
  directory = '';
  camera = null;
  captures = [];
  capture = { isShooting: false, saving: [] };
  viewerName = null;
  newestCaptureName = null;
  rawProgress = null;
  // Whether the server reaches the camera; null until it has tried.
  isCameraConnected = null;
  isLiveViewPausedForRaw = false;

  // Replaces the save folder's listing. A viewer showing a shot that left the
  // listing moves to the shot that took its place, or closes.
  applySession(snapshot) {
    const previousNames = this.captures.map((entry) => entry.name);
    const previousIndex = previousNames.indexOf(this.viewerName);
    this.directory = snapshot.directory;
    this.camera = snapshot.camera;
    this.isLiveViewPausedForRaw = snapshot.isLiveViewPausedForRaw ?? false;
    this.captures = snapshot.captures;

    const isViewedShotGone = previousIndex >= 0 && this.#indexOf(this.viewerName) < 0;
    if (isViewedShotGone) {
      this.viewerName = this.captures[Math.min(previousIndex, this.captures.length - 1)]?.name ?? null;
    }

    const isProgressStale = this.rawProgress !== null && this.#find(this.rawProgress.name)?.raw !== 'downloading';
    if (isProgressStale) {
      this.rawProgress = null;
    }
  }

  // Applies one event from the server stream and returns the effects for app.js.
  applyServerEvent(event) {
    switch (event.type) {
      case 'hello': {
        this.isCameraConnected = event.isCameraConnected ?? null;
        this.capture = event.capture;
        this.applySession(event.session);
      } break;

      case 'connection': {
        this.isCameraConnected = event.isConnected;
        if (event.isConnected) {
          return [{ type: 'refresh-status' }];
        }
      } break;

      case 'capture': {
        return this.#applyCaptureStep(event);
      }

      case 'session': {
        this.applySession(event.session);
      } break;

      case 'raw-progress': {
        this.rawProgress = { name: event.name, receivedBytes: event.receivedBytes, totalBytes: event.totalBytes };
      } break;

      case 'raw-failed': {
        const message = event.retryInMilliseconds === null ? RAW_FAILED_GIVEN_UP(event) : RAW_FAILED_RETRYING(event);

        return [{ type: 'toast', message }];
      }
    }

    return [];
  }

  #applyCaptureStep(step) {
    this.capture = step.state;
    switch (step.phase) {
      case 'shot': {
        return [{ type: 'refresh-status' }];
      }

      case 'preview': {
        this.newestCaptureName = step.name;
        if (step.isAutoPreview) {
          this.viewerName = step.name;
        }
      } break;

      case 'error': {
        return [{ type: 'toast', message: `Capture failed: ${step.error}` }, { type: 'refresh-status' }];
      }
    }

    return [];
  }

  // The camera is firing; settings, focus and capture wait.
  get isCameraBusy() {
    return this.capture.isShooting;
  }

  // Capture waits for the camera, and in auto preview for the shown shot's JPEG.
  get isCaptureBlocked() {
    return this.capture.isShooting || this.capture.saving.some((entry) => entry.isAutoPreview);
  }

  // Why live view shows no frames, for the message over the viewport.
  get liveViewMessage() {
    if (this.isCameraConnected === false) {
      return 'Camera not reachable';
    }

    if (this.isLiveViewPausedForRaw) {
      return 'Live view paused while RAW files download';
    }

    return 'Waiting for live view';
  }

  get captureOverlayText() {
    if (this.capture.isShooting) {
      return 'Taking picture...';
    }

    if (this.capture.saving.some((entry) => entry.isAutoPreview)) {
      return 'Saving JPEG...';
    }

    return null;
  }

  // RAW counts across the listing and the current download's progress in percent, or null.
  get rawSummary() {
    const count = (state) => this.captures.filter((entry) => entry.raw === state).length;
    const { rawProgress } = this;
    const percent = rawProgress?.totalBytes ? Math.floor((rawProgress.receivedBytes / rawProgress.totalBytes) * 100) : null;

    return { downloading: count('downloading'), onCamera: count('on-camera'), percent, progressName: rawProgress?.name ?? null };
  }

  // The shot the viewer shows, or null when it is closed. A shot whose
  // preview arrived before the listing did is shown with what is known.
  get viewedCapture() {
    if (this.viewerName === null) {
      return null;
    }

    return this.#find(this.viewerName) ?? { name: this.viewerName, files: [], fullImage: null, raw: null, modifiedAt: 0 };
  }

  // Whether the viewed shot is in the listing, so it can be deleted or its RAW fetched.
  get isViewedCaptureListed() {
    return this.viewerName !== null && this.#indexOf(this.viewerName) >= 0;
  }

  // The line of file names under the viewer's title.
  viewerFilesText(entry) {
    const isSaving = this.capture.saving.some((saving) => saving.name === entry.name);
    if (isSaving) {
      return 'saving JPEG...';
    }

    if (entry.files.length > 0) {
      return entry.files.join('  ');
    }

    // A RAW-only shot has no JPEG; the viewer shows the camera's preview.
    return entry.raw !== null ? 'RAW only: preview shown' : 'no files';
  }

  openViewer(name) {
    this.viewerName = name;
  }

  closeViewer() {
    this.viewerName = null;
  }

  // Moves the viewer by offset in the listing (newest first, so +1 is older).
  stepViewer(offset) {
    const index = this.#indexOf(this.viewerName);
    const next = this.captures[index + offset];
    if (index >= 0 && next) {
      this.viewerName = next.name;
    }
  }

  #find(name) {
    return this.captures.find((entry) => entry.name === name) ?? null;
  }

  #indexOf(name) {
    return this.captures.findIndex((entry) => entry.name === name);
  }
}
