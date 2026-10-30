#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CameraController } from './camera-controller.js';
import { CaptureFlow } from './capture-flow.js';
import { createHttpServer } from './http-server.js';
import { LiveView } from './liveview.js';
import { LumixCamera } from './lumix.js';
import { CaptureSession } from './session.js';

const CONFIG_PATH = path.join(homedir(), '.config', 'lumix-remote', 'config.json');

const { values: options } = parseArgs({
  options: {
    camera: { type: 'string', default: '192.168.54.1' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8080' },
    directory: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

const config = await loadConfig();
const camera = new LumixCamera({ host: options.camera });
const controller = new CameraController({ camera, liveView: new LiveView({ camera, verbose: options.verbose }) });
const session = new CaptureSession({ controller, directory: '.' });
camera.on('connection', (isConnected) => {
  if (isConnected) {
    console.log(`camera connected at ${camera.host}`);
  } else {
    console.error(`camera not reachable at ${camera.host}`);
  }
});
// Live view repeats the request whenever it (re)starts the stream.
camera.requestAccess().catch((error) => {
  if (error.result !== 'unreachable') {
    console.error(`camera access: ${error.message}`);
  }
});
await session.setDirectory(options.directory ?? config.directory ?? path.join(homedir(), 'Pictures', 'lumix'));

function formatMegabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// RAW downloads: one line when a batch starts and one when the queue is
// empty again; each file with --verbose; failures always.
let rawBatch = null;
session.on('raw-pending', (names) => {
  if (names.length > 0 && rawBatch === null) {
    rawBatch = { startedAt: Date.now(), saved: 0, failed: 0 };
    console.log(`RAW download started: ${names.length} file${names.length === 1 ? '' : 's'} queued`);
  } else if (names.length === 0 && rawBatch !== null) {
    const { saved, failed, startedAt } = rawBatch;
    console.log(`RAW download finished: ${saved} saved, ${failed} failed, ${formatDuration(Date.now() - startedAt)}`);
    rawBatch = null;
  }
});

session.on('raw-saved', ({ name, bytes, milliseconds }) => {
  if (rawBatch !== null) {
    rawBatch.saved += 1;
  }

  if (options.verbose) {
    const kilobytesPerSecond = Math.round(bytes / Math.max(milliseconds, 1));
    console.log(`  ${name}.RW2 saved: ${formatMegabytes(bytes)} in ${formatDuration(milliseconds)} (${kilobytesPerSecond} KB/s)`);
  }
});

session.on('raw-failed', ({ name, error, retryInMilliseconds }) => {
  if (retryInMilliseconds === null) {
    if (rawBatch !== null) {
      rawBatch.failed += 1;
    }

    console.error(`${name}.RW2 download given up: ${error.message}`);
  } else {
    console.error(`${name}.RW2 download failed: ${error.message}; retrying in ${formatDuration(retryInMilliseconds)}`);
  }
});

const server = createHttpServer({
  controller,
  captureFlow: new CaptureFlow({ session }),
  session,
  onDirectoryChange: (directory) => saveConfig({ ...config, directory }),
});

server.listen(Number(options.port), options.host, () => {
  console.log(`Lumix remote on http://${options.host}:${options.port}  (saving to ${session.directory})`);
});

// Stops the camera stream if it answers within a second, then exits.
function shutDown() {
  setTimeout(() => process.exit(0), 1000).unref();
  controller.close().finally(() => process.exit(0));
}

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
