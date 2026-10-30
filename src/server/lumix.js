// Client for the HTTP API that Panasonic Lumix cameras expose over WiFi
// (cam.cgi on port 80, UPnP ContentDirectory on port 60606).
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export class CameraError extends Error {
  constructor(message, result = null) {
    super(message);
    this.result = result;
  }
}

const SAFE_VALUE = /^[A-Za-z0-9_:/.+-]+$/;

// cam.cgi answers with XML (<result>ok</result>) for most commands and with
// comma separated text ("ok,..." or "err_reject,0,0") for camctrl and lens info.
export function parseResult(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const match = trimmed.match(/<result>([^<]*)<\/result>/);
    return match ? match[1] : 'err_unparsable';
  }

  return trimmed.split(',')[0];
}

export function parseSettingValue(text, type) {
  const match = text.match(new RegExp(`<settingvalue[^>]*\\b${type}="([^"]*)"`));
  return match ? match[1] : null;
}

// Returns Map<menuId, {isEnabled, value}> for every menu item, keyed without
// the "menu_item_id_" prefix.
export function parseMenu(text) {
  const items = new Map();
  const itemPattern = /<item id="menu_item_id_([^"]+)" enable="(yes|no)"(?: value="([^"]*)")?/g;
  for (const match of text.matchAll(itemPattern)) {
    items.set(match[1], { isEnabled: match[2] === 'yes', value: match[3] ?? null });
  }

  return items;
}

// Lens info is "ok,maxAv,minAv,maxTv,minTv,..." with APEX fractions.
export function parseLensRange(text) {
  const fields = text.trim().split(',');
  if (fields[0] !== 'ok' || fields.length < 5) {
    return null;
  }

  const toNumber = (field) => {
    const [numerator, denominator] = field.split('/').map(Number);
    return numerator / denominator;
  };

  const [maximumAperture, minimumAperture, maximumTime, minimumTime] = fields.slice(1, 5).map(toNumber);
  if (![maximumAperture, minimumAperture, maximumTime, minimumTime].every(Number.isFinite)) {
    return null;
  }

  return { minimumAperture, maximumAperture, minimumTime, maximumTime };
}

function decodeXmlEntities(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

// Each image on the card is one UPnP item with several resources:
// DO = original (JPG and/or RW2), DL = large JPEG preview, DT = thumbnail.
export function parseContentResources(soapResponse) {
  const didl = decodeXmlEntities(soapResponse);
  const resources = [];
  for (const match of didl.matchAll(/<res\b[^>]*>([^<]+)<\/res>/g)) {
    const url = match[1].trim();
    const nameMatch = url.match(/\/D([OLT])(\d+)\.(\w+)$/);
    if (!nameMatch) {
      continue;
    }

    const kind = { O: 'original', L: 'preview', T: 'thumbnail' }[nameMatch[1]];
    resources.push({ url, kind, number: nameMatch[2], extension: nameMatch[3].toUpperCase() });
  }

  return resources;
}

function browseRequest(startingIndex, requestedCount) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    '<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1" ' +
    'xmlns:pana="urn:schemas-panasonic-com:pana">' +
    '<ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>' +
    `<StartingIndex>${startingIndex}</StartingIndex><RequestedCount>${requestedCount}</RequestedCount>` +
    '<SortCriteria></SortCriteria><pana:X_FromCP>LumixLink2.0</pana:X_FromCP>' +
    '</u:Browse></s:Body></s:Envelope>'
  );
}

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

// Events: 'connection' (isConnected) when the camera starts or stops answering.
export class LumixCamera extends EventEmitter {
  #queue = Promise.resolve();

  // Whether the last request reached the camera; null before the first one.
  isConnected = null;

  constructor({ host = '192.168.54.1', fetchFunction = fetch, pollIntervalMilliseconds = 1000 } = {}) {
    super();
    this.host = host;
    this.fetchFunction = fetchFunction;
    this.pollIntervalMilliseconds = pollIntervalMilliseconds;
  }

  // The camera handles one request at a time; overlapping requests get err_busy.
  #serialize(task) {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #request(url, options = {}, timeoutMilliseconds = 5000) {
    let response;
    try {
      response = await this.fetchFunction(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(timeoutMilliseconds),
      });
    } catch (error) {
      // A request aborted by its caller says nothing about the camera.
      if (!options.signal) {
        this.#setConnected(false);
      }
      throw new CameraError(`camera unreachable at ${this.host}: ${error.cause?.code ?? error.message}`, 'unreachable');
    }

    this.#setConnected(true);

    if (!response.ok) {
      throw new CameraError(`HTTP ${response.status} from ${url}`);
    }

    return response;
  }

  #setConnected(isConnected) {
    if (this.isConnected !== isConnected) {
      this.isConnected = isConnected;
      this.emit('connection', isConnected);
    }
  }

  command(query) {
    return this.#serialize(async () => {
      const response = await this.#request(`http://${this.host}/cam.cgi?${query}`);
      const text = await response.text();
      const result = parseResult(text);
      if (result !== 'ok') {
        throw new CameraError(`${query}: ${result}`, result);
      }

      return text;
    });
  }

  async getSetting(type) {
    return parseSettingValue(await this.command(`mode=getsetting&type=${type}`), type);
  }

  async setSetting(type, value) {
    if (!SAFE_VALUE.test(type) || !SAFE_VALUE.test(value)) {
      throw new CameraError(`invalid setting ${type}=${value}`, 'err_param');
    }

    await this.command(`mode=setsetting&type=${type}&value=${value}`);
  }

  async getMenu() {
    return parseMenu(await this.command('mode=getinfo&type=curmenu'));
  }

  async getLensRange() {
    return parseLensRange(await this.command('mode=getinfo&type=lens'));
  }

  async getState() {
    const text = await this.command('mode=getstate');
    const field = (name) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? null;
    return {
      battery: field('batt'),
      cameraMode: field('cammode'),
      remainingShots: field('remaincapacity'),
      sdCardStatus: field('sdcardstatus'),
    };
  }

  // Registers this program as the camera's remote. A freshly started camera
  // answers commands only after this request.
  async requestAccess(deviceName = 'lumix-remote') {
    await this.command(`mode=accctrl&type=req_acc&value=0&value2=${deviceName}`);
    await this.command(`mode=setsetting&type=device_name&value=${deviceName}`);
  }

  recordMode() {
    return this.command('mode=camcmd&value=recmode');
  }

  playMode() {
    return this.command('mode=camcmd&value=playmode');
  }

  startStream(port) {
    return this.command(`mode=startstream&value=${port}`);
  }

  stopStream() {
    return this.command('mode=stopstream');
  }

  // Touches a point of the frame; x and y run from 0 to 1000.
  async touchFocus(x, y) {
    const position = `${Math.round(x)}/${Math.round(y)}`;
    await this.command(`mode=camctrl&type=touch&value=${position}&value2=on`);
    await this.command(`mode=camctrl&type=touch&value=${position}&value2=off`);
  }

  // Moves the focus motor; the camera accepts this only with the focus lever on MF.
  // Answers "ok,<position>,<maximum>".
  async driveFocus(direction, speed) {
    const prefix = direction === 'far' ? 'tele' : 'wide';
    const suffix = speed === 'fast' ? 'fast' : 'normal';
    const text = await this.command(`mode=camctrl&type=focus&value=${prefix}-${suffix}`);
    const [, position, maximum] = text.trim().split(',').map(Number);

    return Number.isFinite(position) && Number.isFinite(maximum) ? { position, maximum } : null;
  }

  // The camera reports content info only in playback mode; in record mode it
  // answers err_busy after a capture.
  async getContentCount() {
    const text = await this.command('mode=get_content_info');
    const count = Number(text.match(/<total_content_number>(\d+)<\/total_content_number>/)?.[1]);
    if (!Number.isFinite(count)) {
      throw new CameraError('content info without total_content_number');
    }

    return count;
  }

  async contentResources(index) {
    return this.#serialize(async () => {
      const response = await this.#request(`http://${this.host}:60606/Server0/CDS_control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
        },
        body: browseRequest(index, 1),
      });

      return parseContentResources(await response.text());
    });
  }

  // Fires the shutter and returns the resources of the new image. Leaves the
  // camera in playback mode so the files can be downloaded. The camera accepts
  // the command even when it then refuses to fire (no focus lock), so a shot
  // without an image within timeoutMilliseconds is cancelled.
  async captureImage({ timeoutMilliseconds = 60000 } = {}) {
    await this.playMode();
    const countBefore = await this.getContentCount();
    await this.recordMode();
    await this.command('mode=camcmd&value=capture');

    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMilliseconds);
      try {
        await this.playMode();
        const count = await this.getContentCount();
        if (count > countBefore) {
          return await this.contentResources(count - 1);
        }
      } catch (error) {
        if (error.result !== 'err_busy' && error.result !== 'err_reject') {
          throw error;
        }
      }
    }

    try {
      await this.command('mode=camcmd&value=capture_cancel');
    } catch {
      // The shot is reported as failed either way.
    }

    throw new CameraError(
      `the camera took no picture within ${Math.round(timeoutMilliseconds / 1000)} s (focus not found?)`,
      'timeout',
    );
  }

  // Downloads into a .part file, renamed when complete. Fails when no data
  // arrives for idleTimeoutMilliseconds, or with result 'aborted' when signal
  // aborts. With isResumable a failed download keeps its .part file and the
  // next attempt continues from its end. onProgress(receivedBytes, totalBytes)
  // runs for every chunk; totalBytes is null when the camera sends no length.
  async download(
    url,
    destinationPath,
    { idleTimeoutMilliseconds = 20000, onProgress = () => {}, signal = null, isResumable = false } = {},
  ) {
    const idleController = new AbortController();
    let idleTimer = null;
    const restartIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idleController.abort(), idleTimeoutMilliseconds);
    };
    const partialPath = `${destinationPath}.part`;
    const resumeOffset = isResumable ? await fileSize(partialPath) : 0;
    restartIdleTimer();

    try {
      const response = await this.#request(url, {
        signal: signal ? AbortSignal.any([idleController.signal, signal]) : idleController.signal,
        headers: resumeOffset > 0 ? { Range: `bytes=${resumeOffset}-` } : {},
      });
      const isAppending = response.status === 206;
      const totalBytes = isAppending
        ? Number(response.headers.get('content-range')?.split('/')[1]) || null
        : Number(response.headers.get('content-length')) || null;
      let receivedBytes = isAppending ? resumeOffset : 0;
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (chunks) {
          for await (const chunk of chunks) {
            restartIdleTimer();
            receivedBytes += chunk.length;
            onProgress(receivedBytes, totalBytes);
            yield chunk;
          }
        },
        createWriteStream(partialPath, { flags: isAppending ? 'a' : 'w' }),
      );
      await rename(partialPath, destinationPath);
    } catch (error) {
      if (!isResumable) {
        await unlink(partialPath).catch(() => {});
      }
      if (signal?.aborted) {
        throw new CameraError('download aborted', 'aborted');
      }
      if (idleController.signal.aborted) {
        throw new CameraError(`download stalled: no data for ${idleTimeoutMilliseconds / 1000}s`, 'timeout');
      }
      throw error;
    } finally {
      clearTimeout(idleTimer);
    }
  }
}
