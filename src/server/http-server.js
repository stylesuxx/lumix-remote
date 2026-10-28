// The page's HTTP interface: static files, one stream per page carrying live
// view frames and server events, and a JSON interface over the camera
// controller and capture session.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { encodeEvent, encodeFrame, STREAM_CONTENT_TYPE } from '../shared/stream-codec.js';
import { CameraBusyError } from './camera-controller.js';
import { CameraError } from './lumix.js';
import { createDirectory, InvalidCaptureError, listDirectories } from './session.js';
import { UnknownSettingError } from './settings.js';

function sourceFile(relativePath) {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

// The page's files: the browser code and the stream codec it shares with the server.
const STATIC_FILES = {
  '/': [sourceFile('../browser/index.html'), 'text/html; charset=utf-8'],
  '/app.js': [sourceFile('../browser/app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [sourceFile('../browser/style.css'), 'text/css; charset=utf-8'],
  '/stream-codec.js': [sourceFile('../shared/stream-codec.js'), 'text/javascript; charset=utf-8'],
};

// A request the client got wrong.
class RequestError extends Error {}

function statusFor(error) {
  if (error instanceof RequestError || error instanceof UnknownSettingError || error instanceof InvalidCaptureError) {
    return 400;
  }

  if (error instanceof CameraBusyError) {
    return 409;
  }

  if (error instanceof CameraError) {
    return 502;
  }

  return 500;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError('request body is not valid JSON');
  }
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(`invalid path segment: ${segment}`);
  }
}

async function serveFile(response, filePath, contentType) {
  try {
    const { size } = await stat(filePath);
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': size, 'Cache-Control': 'no-cache' });
    createReadStream(filePath)
      .on('error', () => response.destroy())
      .pipe(response);
  } catch {
    sendJson(response, 404, { error: 'not found' });
  }
}

function contentTypeFor(fileName) {
  return /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : 'application/octet-stream';
}

// controller: CameraController. session: CaptureSession. onDirectoryChange is
// called with the new save folder after the page changes it.
export function createHttpServer({ controller, session, onDirectoryChange = async () => {} }) {
  const streamClients = new Set();

  function broadcast(event) {
    const part = encodeEvent(event);
    for (const response of streamClients) {
      response.write(part);
    }
  }

  session.on('raw-pending', (names) => broadcast({ type: 'raw-pending', names }));
  session.on('raw-progress', (progress) => broadcast({ type: 'raw-progress', ...progress }));
  session.on('raw-saved', ({ name }) => broadcast({ type: 'raw-saved', name }));
  session.on('raw-failed', ({ name, error, retryInMilliseconds }) =>
    broadcast({ type: 'raw-failed', name, error: error.message, retryInMilliseconds }),
  );

  async function sessionState() {
    return {
      directory: session.directory,
      captures: await session.listCaptures(),
      camera: await session.readCameraInfo(),
    };
  }

  async function runCapture({ isLiveViewHeld }) {
    broadcast({ type: 'capture', phase: 'shooting' });
    try {
      const { name, files } = await session.capture({
        isLiveViewHeld,
        onShot: () => broadcast({ type: 'capture', phase: 'shot' }),
        onPreview: (previewName) => broadcast({ type: 'capture', phase: 'downloading', name: previewName }),
      });
      broadcast({ type: 'capture', phase: 'done', name, files });
    } catch (error) {
      console.error(`capture: ${error.message}`);
      broadcast({ type: 'capture', phase: 'error', error: error.message });
    }
  }

  // Browsers allow six connections per server, so each page gets one stream
  // for both live view and events. It opens with a hello event.
  function serveStream(request, response) {
    response.writeHead(200, { 'Content-Type': STREAM_CONTENT_TYPE, 'Cache-Control': 'no-store', Connection: 'close' });
    response.write(
      encodeEvent({ type: 'hello', isCapturing: controller.isCapturing, pendingRaw: session.pendingRawNames }),
    );
    streamClients.add(response);
    const removeViewer = controller.addViewer((frame) => {
      // A client that falls behind skips frames.
      if (response.writableLength > frame.length * 2) {
        return;
      }

      response.write(encodeFrame(frame));
    });
    request.on('close', () => {
      streamClients.delete(response);
      removeViewer();
    });
  }

  const routes = {
    'GET /api/status': async ({ url }) => controller.readStatus({ isFull: url.searchParams.has('full') }),

    'POST /api/settings': async ({ body }) => {
      await controller.applySetting(body.key, body.value);
      return controller.readStatus({ isFull: true });
    },

    'POST /api/focus/point': async ({ body }) => {
      const clamp = (number) => Math.min(1000, Math.max(0, Number(number)));
      await controller.focusAt(clamp(body.x), clamp(body.y));
      return { ok: true };
    },

    'POST /api/focus/drive': async ({ body }) => ({ position: await controller.driveFocus(body.direction, body.speed) }),

    'POST /api/capture': async ({ body }) => {
      if (controller.isCapturing) {
        throw new CameraBusyError('a capture is in progress');
      }
      runCapture({ isLiveViewHeld: body.isLiveViewHeld === true });

      return { ok: true };
    },

    'GET /api/session': async () => sessionState(),

    'POST /api/session': async ({ body }) => {
      if (typeof body.directory !== 'string' || body.directory.trim() === '') {
        throw new RequestError('directory is required');
      }

      try {
        await session.setDirectory(body.directory);
      } catch (error) {
        throw new RequestError(`cannot use ${body.directory}: ${error.message}`);
      }

      await onDirectoryChange(session.directory);
      return sessionState();
    },

    'POST /api/raw': async ({ body }) => ({ queued: await session.downloadRaw(body.names ?? null) }),

    'GET /api/directories': async ({ url }) => {
      const requested = url.searchParams.get('path') ?? session.directory;
      try {
        return await listDirectories(requested);
      } catch (error) {
        throw new RequestError(`cannot open ${requested}: ${error.message}`);
      }
    },

    'POST /api/directories': async ({ body }) => {
      try {
        return await listDirectories(await createDirectory(body.path, body.name));
      } catch (error) {
        throw new RequestError(error.message);
      }
    },
  };

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/stream') {
      serveStream(request, response);
      return;
    }

    const captureMatch = url.pathname.match(/^\/api\/captures\/([^/]+)$/);
    if (captureMatch && request.method === 'DELETE') {
      await session.deleteCapture(decodePathSegment(captureMatch[1]));
      sendJson(response, 200, await sessionState());
      return;
    }

    const route = routes[`${request.method} ${url.pathname}`];
    if (route) {
      const body = request.method === 'POST' ? await readJsonBody(request) : {};
      sendJson(response, 200, await route({ url, body }));
      return;
    }

    const fileMatch = url.pathname.match(/^\/files\/(preview|original)\/([^/]+)$/);
    if (fileMatch) {
      const fileName = decodePathSegment(fileMatch[2]);
      const filePath = session.resolveFile(fileName, fileMatch[1] === 'preview');
      if (!filePath) {
        throw new RequestError('invalid file name');
      }
      await serveFile(response, filePath, contentTypeFor(fileName));
      return;
    }

    const staticFile = STATIC_FILES[url.pathname];
    if (staticFile) {
      await serveFile(response, staticFile[0], staticFile[1]);
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  }

  return createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      const status = statusFor(error);
      if (status === 500) {
        console.error(error);
      }
      if (!response.headersSent) {
        sendJson(response, status, { error: error.message, result: error.result ?? null });
      }
    }
  });
}
