// The save folder and every file a shot produces in it. Originals keep the
// card's file number (P1100135.JPG, P1100135.RW2). A hidden .previews folder
// holds the camera's large JPEG preview for the gallery and a sidecar
// (P1100135.json) recording where the shot's RAW file is on the card.
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { DownloadQueue } from './download-queue.js';
import { readCameraInfo } from './exif.js';
import { expandHome } from './folders.js';

const PREVIEW_FOLDER = '.previews';
const RAW_EXTENSION = 'RW2';

export class InvalidCaptureError extends Error {}

function timestamp(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function isExisting(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isPlainName(name) {
  return typeof name === 'string' && name !== '' && name === path.basename(name) && !name.startsWith('.');
}

// Events: 'change' whenever the listing may have changed, 'raw-pending'
// (names of captures whose RAW is queued), 'raw-progress' ({ name,
// receivedBytes, totalBytes }, about once a second), 'raw-saved' ({ name,
// bytes, milliseconds }) and 'raw-failed' ({ name, error, retryInMilliseconds
// }), where retryInMilliseconds is null once given up.
export class CaptureSession extends EventEmitter {
  #queue;

  // controller: something with capture() and download(url, destinationPath),
  // normally the CameraController.
  constructor({ controller, directory, retryDelaysMilliseconds }) {
    super();
    this.controller = controller;
    this.directory = path.resolve(expandHome(directory));
    this.#queue = new DownloadQueue({
      download: (url, destinationPath, onProgress, signal) =>
        controller.download(url, destinationPath, { onProgress, signal, isResumable: true }),
      retryDelaysMilliseconds,
    });
    this.#queue.on('change', () => {
      this.emit('raw-pending', this.#queue.pendingKeys);
      this.emit('change');
    });
    this.#queue.on('progress', (job) =>
      this.emit('raw-progress', { name: job.key, receivedBytes: job.receivedBytes, totalBytes: job.totalBytes }),
    );
    this.#queue.on('done', (job) =>
      this.emit('raw-saved', { name: job.key, bytes: job.receivedBytes, milliseconds: job.milliseconds }),
    );
    this.#queue.on('discarded', (job) =>
      Promise.all([job.destinationPath, `${job.destinationPath}.part`].map((filePath) => rm(filePath, { force: true }))).catch(
        () => {},
      ),
    );
    this.#queue.on('failed', ({ job, error, retryInMilliseconds }) =>
      this.emit('raw-failed', { name: job.key, error, retryInMilliseconds }),
    );
  }

  get previewDirectory() {
    return path.join(this.directory, PREVIEW_FOLDER);
  }


  async setDirectory(directory) {
    const resolved = path.resolve(expandHome(directory.trim()));
    await mkdir(path.join(resolved, PREVIEW_FOLDER), { recursive: true });
    await access(resolved, constants.W_OK);
    this.directory = resolved;
    this.emit('change');

    return resolved;
  }

  // The card name (P1100136), or the card name behind a timestamp when any of
  // its files already exist here, since the card's counter can restart.
  async #baseName(number, extensions) {
    const cardName = `P${number}`;
    const targetPaths = [
      ...extensions.map((extension) => path.join(this.directory, `${cardName}.${extension}`)),
      path.join(this.previewDirectory, `${cardName}.jpg`),
    ];
    const existing = await Promise.all(targetPaths.map(isExisting));
    return existing.includes(true) ? `${timestamp()}_${cardName}` : cardName;
  }

  // Shoots (reported through onShot once the camera is free again), saves
  // the preview (reported through onPreview) and then the JPEG. A RAW file
  // stays on the card until downloadRaw fetches it; RAW downloads pause from
  // the shutter until the JPEG is saved and then continue where they stopped.
  // With isLiveViewHeld, live view stays paused until the JPEG is saved, which
  // speeds up the download.
  async capture({ onShot = () => {}, onPreview = () => {}, isLiveViewHeld = false } = {}) {
    await mkdir(this.previewDirectory, { recursive: true });
    this.#queue.pause();
    try {
      const resources = await this.controller.capture({ isLiveViewHeld });
      onShot();
      try {
        return await this.#saveShot(resources, onPreview);
      } finally {
        if (isLiveViewHeld) {
          await this.controller.releaseLiveView();
        }
      }
    } finally {
      this.#queue.resume();
    }
  }

  async #saveShot(resources, onPreview) {
    const originals = resources.filter((resource) => resource.kind === 'original');
    const preview = resources.find((resource) => resource.kind === 'preview');
    if (originals.length === 0) {
      throw new Error('the camera listed no original file for the new image');
    }

    const name = await this.#baseName(
      originals[0].number,
      originals.map((resource) => resource.extension),
    );

    const raw = originals.find((resource) => resource.extension === RAW_EXTENSION);
    await writeFile(
      path.join(this.previewDirectory, `${name}.json`),
      `${JSON.stringify({ rawUrl: raw?.url ?? null }, null, 2)}\n`,
    );
    if (preview) {
      await this.controller.download(preview.url, path.join(this.previewDirectory, `${name}.jpg`));
      onPreview(name);
      this.emit('change');
    }
    const files = [];
    for (const original of originals.filter((resource) => resource !== raw)) {
      const fileName = `${name}.${original.extension}`;
      await this.controller.download(original.url, path.join(this.directory, fileName));
      files.push(fileName);
    }
    this.emit('change');

    return { name, files };
  }

  async #readSidecar(name) {
    try {
      return JSON.parse(await readFile(path.join(this.previewDirectory, `${name}.json`), 'utf8'));
    } catch {
      return {};
    }
  }

  // Captures in the current folder, newest first. raw is 'saved',
  // 'downloading', 'on-camera' or null when no RAW location is recorded.
  async listCaptures() {
    let previewNames;
    let directoryNames;
    try {
      [previewNames, directoryNames] = await Promise.all([readdir(this.previewDirectory), readdir(this.directory)]);
    } catch {
      return [];
    }

    const pending = new Set(this.#queue.pendingKeys);
    const captures = [];
    for (const previewName of previewNames) {
      if (!previewName.endsWith('.jpg')) {
        continue;
      }

      const name = previewName.slice(0, -'.jpg'.length);
      const files = directoryNames.filter((fileName) => path.parse(fileName).name === name);
      const { mtimeMs } = await stat(path.join(this.previewDirectory, previewName));
      const { rawUrl } = await this.#readSidecar(name);
      let raw = null;
      if (files.some((fileName) => fileName.toUpperCase().endsWith(`.${RAW_EXTENSION}`))) {
        raw = 'saved';
      } else if (pending.has(name)) {
        raw = 'downloading';
      } else if (rawUrl) {
        raw = 'on-camera';
      }

      captures.push({
        name,
        files,
        fullImage: files.find((fileName) => /\.jpe?g$/i.test(fileName)) ?? null,
        raw,
        modifiedAt: mtimeMs,
      });
    }

    return captures.sort((first, second) => second.modifiedAt - first.modifiedAt);
  }

  // The save folder, its captures (see listCaptures) and the camera's
  // { model, firmware } read from the newest JPEG, or null without one.
  async snapshot() {
    const captures = await this.listCaptures();
    const newest = captures.find((capture) => capture.fullImage !== null);
    const camera = newest ? await readCameraInfo(path.join(this.directory, newest.fullImage)).catch(() => null) : null;

    return { directory: this.directory, captures, camera };
  }

  // Queues the RAW of every listed capture that has one on the card and not
  // here yet; all such captures when names is omitted. Resolves to the names queued.
  async downloadRaw(names = null) {
    const wanted = names === null ? null : new Set(names);
    const queued = [];
    for (const capture of await this.listCaptures()) {
      if (capture.raw !== 'on-camera' || (wanted && !wanted.has(capture.name))) {
        continue;
      }

      const { rawUrl } = await this.#readSidecar(capture.name);
      this.#queue.add({
        key: capture.name,
        url: rawUrl,
        destinationPath: path.join(this.directory, `${capture.name}.${RAW_EXTENSION}`),
      });
      queued.push(capture.name);
    }

    return queued;
  }

  // Deletes a capture's files from this folder (the card keeps its copy) and
  // drops its RAW from the download queue.
  async deleteCapture(name) {
    if (!isPlainName(name)) {
      throw new InvalidCaptureError(`invalid capture name: ${name}`);
    }

    this.#queue.remove(name);
    const directoryNames = await readdir(this.directory);
    const files = directoryNames.filter((fileName) => path.parse(fileName).name === name);
    await Promise.all([
      ...files.map((fileName) => unlink(path.join(this.directory, fileName))),
      rm(path.join(this.previewDirectory, `${name}.jpg`), { force: true }),
      rm(path.join(this.previewDirectory, `${name}.json`), { force: true }),
    ]);
    this.emit('change');
  }

  // Resolves a requested file inside the save folder, rejecting anything
  // that would escape it.
  resolveFile(fileName, isPreview) {
    if (!isPlainName(fileName)) {
      return null;
    }

    return path.join(isPreview ? this.previewDirectory : this.directory, fileName);
  }
}
