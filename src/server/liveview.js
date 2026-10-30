// Receives the camera's live view: after startstream, the camera sends one
// UDP datagram per frame to the requesting host, a header followed by a JPEG.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

const JPEG_START = Buffer.from([0xff, 0xd8]);
const KEEPALIVE_INTERVAL_MILLISECONDS = 3000;
const STALL_MILLISECONDS = 3000;

// Bytes 30-31 of the header hold the length of the variable header part
// that follows the fixed 32 bytes.
export function extractJpeg(packet) {
  if (packet.length < 34) {
    return null;
  }

  const offset = 32 + packet.readUInt16BE(30);
  if (packet[offset] === 0xff && packet[offset + 1] === 0xd8) {
    return packet.subarray(offset);
  }

  const start = packet.indexOf(JPEG_START);
  return start >= 0 ? packet.subarray(start) : null;
}

export class LiveView extends EventEmitter {
  #socket = null;
  #renewTimer = null;
  #renewal = null;
  #lastFrameAt = 0;
  #hasWarnedStalled = false;

  constructor({ camera, port = 49199, verbose = false }) {
    super();
    this.camera = camera;
    this.port = port;
    this.verbose = verbose;
    this.isRunning = false;
    this.latestFrame = null;
  }

  async #bind() {
    if (this.#socket) {
      return;
    }

    const socket = dgram.createSocket('udp4');
    socket.on('message', (packet) => {
      const frame = extractJpeg(packet);
      if (!frame) {
        return;
      }

      this.#lastFrameAt = Date.now();
      if (this.#hasWarnedStalled) {
        console.error('live view: frames are arriving again');
        this.#hasWarnedStalled = false;
      }

      this.latestFrame = frame;
      this.emit('frame', frame);
    });
    socket.on('error', (error) => console.error(`live view socket: ${error.message}`));
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    this.#socket = socket;
  }

  // The camera stops streaming after about 10 seconds without requests.
  // Polling getstate keeps it going; repeating startstream while frames are
  // arriving disrupts the stream, so that is sent only once frames stop.
  #renew() {
    if (!this.isRunning || this.#renewal) {
      return this.#renewal;
    }

    this.#renewal = this.#sendKeepalive().finally(() => {
      this.#renewal = null;
    });

    return this.#renewal;
  }

  async #sendKeepalive() {
    const isStalled = Date.now() - this.#lastFrameAt > STALL_MILLISECONDS;
    if (isStalled && !this.#hasWarnedStalled && this.#lastFrameAt > 0) {
      console.error('live view: no frames from the camera, restarting the stream');
      this.#hasWarnedStalled = true;
    }

    try {
      if (isStalled) {
        await this.camera.requestAccess();
        await this.camera.recordMode();
        await this.camera.startStream(this.port);
      } else {
        await this.camera.getState();
      }
    } catch (error) {
      if (this.verbose) {
        console.error(`live view renew: ${error.message}`);
      }
    }
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    await this.#bind();
    this.isRunning = true;
    this.#lastFrameAt = 0;
    await this.#renew();
    this.#renewTimer = setInterval(() => this.#renew(), KEEPALIVE_INTERVAL_MILLISECONDS);
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    clearInterval(this.#renewTimer);
    this.#renewTimer = null;
    // A keepalive already sent could switch the camera mode after stop returns.
    await this.#renewal;
    try {
      await this.camera.stopStream();
    } catch (error) {
      if (this.verbose) {
        console.error(`live view stop: ${error.message}`);
      }
    }
  }

  // Applies a changed stream setting; changing it mid-stream stalls the camera.
  async restart() {
    if (!this.isRunning) {
      return;
    }

    await this.stop();
    await this.start();
  }

  close() {
    clearInterval(this.#renewTimer);
    this.#socket?.close();
    this.#socket = null;
  }
}
