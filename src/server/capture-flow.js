// Runs each capture from the shutter to the saved JPEG and publishes the state
// of all captures in progress. The shutter is exclusive; the JPEGs of earlier
// captures may still be saving while the next capture fires.
import { EventEmitter } from 'node:events';

import { CameraBusyError } from './camera-controller.js';

// Events: 'capture' ({ phase, id, name, isAutoPreview, files, error, state })
// for each step of a capture, where phase is 'shooting', 'shot' (the camera
// is free again), 'preview' (the preview is saved and name known), 'saved'
// or 'error'; state is the state after the step.
export class CaptureFlow extends EventEmitter {
  #isShooting = false;
  #saving = new Map();
  #nextId = 1;

  // session: a CaptureSession.
  constructor({ session }) {
    super();
    this.session = session;
  }

  // isShooting: the camera is firing. saving: captures whose JPEG is still
  // being saved, oldest first, each { id, name, isAutoPreview }; name is null
  // until the preview is saved.
  get state() {
    return { isShooting: this.#isShooting, saving: [...this.#saving.values()].map((entry) => ({ ...entry })) };
  }

  // Starts a capture and returns its id; throws CameraBusyError while the
  // camera is firing. With isAutoPreview the page shows the new shot, so live
  // view stays paused until its JPEG is saved.
  start({ isAutoPreview = false } = {}) {
    if (this.#isShooting) {
      throw new CameraBusyError('a capture is in progress');
    }

    const id = this.#nextId;
    this.#nextId += 1;
    this.#isShooting = true;
    this.#publish({ phase: 'shooting', id, isAutoPreview });
    this.#run(id, isAutoPreview);

    return id;
  }

  async #run(id, isAutoPreview) {
    try {
      const { name, files } = await this.session.capture({
        isLiveViewHeld: isAutoPreview,
        onShot: () => {
          this.#isShooting = false;
          this.#saving.set(id, { id, name: null, isAutoPreview });
          this.#publish({ phase: 'shot', id, isAutoPreview });
        },
        onPreview: (previewName) => {
          this.#saving.get(id).name = previewName;
          this.#publish({ phase: 'preview', id, name: previewName, isAutoPreview });
        },
      });
      this.#saving.delete(id);
      this.#publish({ phase: 'saved', id, name, files, isAutoPreview });
    } catch (error) {
      console.error(`capture: ${error.message}`);
      this.#isShooting = false;
      this.#saving.delete(id);
      this.#publish({ phase: 'error', id, isAutoPreview, error: error.message });
    }
  }

  #publish(step) {
    this.emit('capture', { ...step, state: this.state });
  }
}
