// The page's HTTP interface: static files, one stream per page carrying live
// view frames and server events, and a JSON interface over the camera
// controller, the capture flow and the capture session.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { encodeEvent, encodeFrame, STREAM_CONTENT_TYPE } from '../shared/stream-codec.js';
import { CameraBusyError } from './camera-controller.js';
import { CameraError } from './lumix.js';
import { createDirectory, InvalidFolderError, listDirectories } from './folders.js';
import { InvalidCaptureError } from './session.js';
import { UnknownSettingError } from './settings.js';

function sourceFile(relativePath) {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

// The page's files: the browser code and the stream codec it shares with the server.
const STATIC_FILES = {
  '/': [sourceFile('../browser/index.html'), 'text/html; charset=utf-8'],
  '/app.js': [sourceFile('../browser/app.js'), 'text/javascript; charset=utf-8'],
  '/page-model.js': [sourceFile('../browser/page-model.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [sourceFile('../browser/style.css'), 'text/css; charset=utf-8'],
  '/stream-codec.js': [sourceFile('../shared/stream-codec.js'), 'text/javascript; charset=utf-8'],
};

// A request the client got wrong.
class RequestError extends Error {}

function statusFor(error) {
  const isRequestError =
    error instanceof RequestError ||
    error instanceof UnknownSettingError ||
    error instanceof InvalidCaptureError ||
    error instanceof InvalidFolderError;
  if (isRequestError) {
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

// controller: CameraController. captureFlow: CaptureFlow. session:
// CaptureSession. onDirectoryChange is called with the new save folder after
// the page changes it.
export function createHttpServer({ controller, captureFlow, session, onDirectoryChange = async () => {} }) {
  const streamClients = new Set();
  let isSessionBroadcastQueued = false;

  function broadcast(event) {
    const part = encodeEvent(event);
    for (const response of streamClients) {
      response.write(part);
    }
  }

  // Several changes in a row produce one listing.
  function queueSessionBroadcast() {
    if (isSessionBroadcastQueued) {
      return;
    }

    isSessionBroadcastQueued = true;
    setImmediate(async () => {
      isSessionBroadcastQueued = false;
      broadcast({ type: 'session', session: await session.snapshot() });
    });
  }

  captureFlow.on('capture', (step) => broadcast({ type: 'capture', ...step }));
  controller.camera.on('connection', (isConnected) => broadcast({ type: 'connection', isConnected }));
  session.on('change', queueSessionBroadcast);
  session.on('raw-progress', (progress) => broadcast({ type: 'raw-progress', ...progress }));
  session.on('raw-failed', ({ name, error, retryInMilliseconds }) =>
    broadcast({ type: 'raw-failed', name, error: error.message, retryInMilliseconds }),
  );

  // Browsers allow six connections per server, so each page gets one stream
  // for both live view and events. It opens with a hello event holding the
  // camera's reachability, the capture state and the save folder's listing.
  async function serveStream(request, response) {
    response.writeHead(200, { 'Content-Type': STREAM_CONTENT_TYPE, 'Cache-Control': 'no-store', Connection: 'close' });
    response.write(
      encodeEvent({
        type: 'hello',
        isCameraConnected: controller.camera.isConnected,
        capture: captureFlow.state,
        session: await session.snapshot(),
      }),
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

  // JSON routes. path is the exact pathname or a pattern whose groups the
  // handler receives as match.
  const routes = [
    {
      method: 'GET',
      path: '/api/status',
      handle: async ({ url }) => controller.readStatus({ isFull: url.searchParams.has('full') }),
    },
    {
      method: 'POST',
      path: '/api/settings',
      handle: async ({ body }) => {
        await controller.applySetting(body.key, body.value);

        return controller.readStatus({ isFull: true });
      },
    },
    {
      method: 'POST',
      path: '/api/focus/point',
      handle: async ({ body }) => {
        const clamp = (number) => Math.min(1000, Math.max(0, Number(number)));
        await controller.focusAt(clamp(body.x), clamp(body.y));

        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/focus/drive',
      handle: async ({ body }) => ({ position: await controller.driveFocus(body.direction, body.speed) }),
    },
    {
      method: 'POST',
      path: '/api/capture',
      handle: async ({ body }) => ({ id: captureFlow.start({ isAutoPreview: body.isAutoPreview === true }) }),
    },
    {
      method: 'GET',
      path: '/api/session',
      handle: async () => session.snapshot(),
    },
    {
      method: 'POST',
      path: '/api/session',
      handle: async ({ body }) => {
        if (typeof body.directory !== 'string' || body.directory.trim() === '') {
          throw new RequestError('directory is required');
        }

        try {
          await session.setDirectory(body.directory);
        } catch (error) {
          throw new RequestError(`cannot use ${body.directory}: ${error.message}`);
        }

        await onDirectoryChange(session.directory);

        return session.snapshot();
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/captures\/([^/]+)$/,
      handle: async ({ match }) => {
        await session.deleteCapture(decodePathSegment(match[1]));

        return session.snapshot();
      },
    },
    {
      method: 'POST',
      path: '/api/raw',
      handle: async ({ body }) => ({ queued: await session.downloadRaw(body.names ?? null) }),
    },
    {
      method: 'GET',
      path: '/api/directories',
      handle: async ({ url }) => listDirectories(url.searchParams.get('path') ?? session.directory),
    },
    {
      method: 'POST',
      path: '/api/directories',
      handle: async ({ body }) => listDirectories(await createDirectory(body.path, body.name)),
    },
  ];

  function findRoute(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) {
        continue;
      }

      const match = typeof route.path === 'string' ? (route.path === pathname ? [pathname] : null) : pathname.match(route.path);
      if (match) {
        return { route, match };
      }
    }

    return null;
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/stream') {
      await serveStream(request, response);
      return;
    }

    const found = findRoute(request.method, url.pathname);
    if (found) {
      const body = request.method === 'POST' ? await readJsonBody(request) : {};
      sendJson(response, 200, await found.route.handle({ url, body, match: found.match }));
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
