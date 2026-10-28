// Owns the camera: its record/playback mode, the live view lifecycle and every
// multi-step sequence. A capture runs alone: commands arriving meanwhile are
// rejected with CameraBusyError, and status reads answer with the last status
// read, without asking the camera.
import { applySetting, readSettings } from './settings.js';

export class CameraBusyError extends Error {}

export class CameraController {
  #viewerCount = 0;
  #stopTimer = null;
  #capture = null;
  #activeCommands = new Set();
  #statusReads = new Map();
  #lastStatus = new Map();

  // camera: a LumixCamera. liveView: a LiveView reading that camera's stream.
  constructor({ camera, liveView, liveViewStopDelayMilliseconds = 2000 }) {
    this.camera = camera;
    this.liveView = liveView;
    this.liveViewStopDelayMilliseconds = liveViewStopDelayMilliseconds;
  }

  get isCapturing() {
    return this.#capture !== null;
  }

  // Live view runs while at least one viewer is registered, and stops a short
  // delay after the last one leaves (a page reload reconnects within it).
  // Returns the function that removes the viewer.
  addViewer(onFrame) {
    this.liveView.on('frame', onFrame);
    this.#viewerCount += 1;
    clearTimeout(this.#stopTimer);
    if (this.liveView.latestFrame) {
      onFrame(this.liveView.latestFrame);
    }

    this.#startLiveViewIfWatched();

    let isRemoved = false;
    return () => {
      if (isRemoved) {
        return;
      }

      isRemoved = true;
      this.liveView.off('frame', onFrame);
      this.#viewerCount -= 1;
      if (this.#viewerCount === 0) {
        this.#stopTimer = setTimeout(() => this.liveView.stop(), this.liveViewStopDelayMilliseconds);
      }
    };
  }

  async #startLiveViewIfWatched() {
    if (this.#viewerCount === 0 || this.isCapturing) {
      return;
    }

    try {
      await this.liveView.start();
    } catch (error) {
      console.error(`live view start: ${error.message}`);
    }
  }

  // Runs a command unless a capture is in progress, and lets a capture that
  // starts later wait for it.
  async #runCommand(task) {
    if (this.isCapturing) {
      throw new CameraBusyError('a capture is in progress');
    }

    const command = task();
    this.#activeCommands.add(command);
    try {
      return await command;
    } finally {
      this.#activeCommands.delete(command);
    }
  }

  // Takes a picture and resolves to the card resources of the new image
  // (see LumixCamera.captureImage). Live view pauses meanwhile and the camera
  // is back in record mode when this resolves.
  async capture() {
    if (this.isCapturing) {
      throw new CameraBusyError('a capture is in progress');
    }

    this.#capture = this.#runCapture();
    try {
      return await this.#capture;
    } finally {
      this.#capture = null;
      await this.#startLiveViewIfWatched();
    }
  }

  async #runCapture() {
    await Promise.allSettled([...this.#activeCommands, ...this.#statusReads.values()]);
    clearTimeout(this.#stopTimer);
    await this.liveView.stop();

    try {
      return await this.camera.captureImage();
    } finally {
      try {
        await this.camera.recordMode();
      } catch (error) {
        console.error(`returning to record mode: ${error.message}`);
      }
    }
  }

  // The camera refocuses on a touch only in the touch_af AF mode, so a focus
  // point also sets that AF mode.
  focusAt(x, y) {
    return this.#runCommand(async () => {
      await this.camera.setSetting('afmode', 'touch_af');
      await this.camera.touchFocus(x, y);
    });
  }

  // Moves the focus motor (focus lever on MF). Resolves to { position, maximum } or null.
  driveFocus(direction, speed) {
    return this.#runCommand(() => this.camera.driveFocus(direction, speed));
  }

  // Throws UnknownSettingError for a key the catalogue does not have.
  applySetting(key, value) {
    return this.#runCommand(async () => {
      const { isLiveViewRestartNeeded } = await applySetting(this.camera, key, value);
      if (isLiveViewRestartNeeded) {
        await this.liveView.restart();
      }
    });
  }

  // The short status holds battery, remaining shots and focus mode; the full
  // one adds every setting. Concurrent reads of the same kind share one read.
  readStatus({ isFull = false } = {}) {
    const kind = isFull ? 'full' : 'short';
    if (this.isCapturing) {
      return Promise.resolve({ ...(this.#lastStatus.get(kind) ?? { isConnected: true }), isCapturing: true });
    }

    if (!this.#statusReads.has(kind)) {
      const read = this.#readStatus(isFull).finally(() => this.#statusReads.delete(kind));
      this.#statusReads.set(kind, read);
    }

    return this.#statusReads.get(kind);
  }

  async #readStatus(isFull) {
    try {
      const state = await this.camera.getState();
      const focusMode = await this.camera.getSetting('focusmode');
      const status = { isConnected: true, isCapturing: false, state, focusMode };

      if (isFull) {
        Object.assign(status, await readSettings(this.camera));
      }

      this.#lastStatus.set(isFull ? 'full' : 'short', status);
      return status;
    } catch (error) {
      return { isConnected: false, isCapturing: this.isCapturing, error: error.message };
    }
  }

  // Downloads a file from the card, alongside other commands.
  download(url, destinationPath, { onProgress } = {}) {
    return this.camera.download(url, destinationPath, { onProgress });
  }

  async close() {
    clearTimeout(this.#stopTimer);
    await this.liveView.stop();
    this.liveView.close();
  }
}
