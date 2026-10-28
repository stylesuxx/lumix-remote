// The stream between server and page, used by both: one
// multipart/x-mixed-replace response carrying live view frames (image/jpeg)
// and server events (application/json). Each part is
// "--frame\r\nContent-Type: <type>\r\nContent-Length: N\r\n\r\n", N bytes, "\r\n".

export const STREAM_CONTENT_TYPE = 'multipart/x-mixed-replace; boundary=frame';

const HEADER_END = [13, 10, 13, 10];
const TRAILER = new Uint8Array([13, 10]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodePart(contentType, body) {
  const header = encoder.encode(`--frame\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n`);
  const part = new Uint8Array(header.length + body.length + TRAILER.length);
  part.set(header);
  part.set(body, header.length);
  part.set(TRAILER, header.length + body.length);

  return part;
}

export function encodeFrame(jpeg) {
  return encodePart('image/jpeg', jpeg);
}

export function encodeEvent(event) {
  return encodePart('application/json', encoder.encode(JSON.stringify(event)));
}

function indexOfSequence(bytes, sequence, start = 0) {
  for (let index = start; index <= bytes.length - sequence.length; index++) {
    if (sequence.every((value, offset) => bytes[index + offset] === value)) {
      return index;
    }
  }

  return -1;
}

// The first complete part in bytes and the bytes after it, or null while the
// bytes hold no complete part.
function takePart(bytes) {
  const headerEnd = indexOfSequence(bytes, HEADER_END);
  if (headerEnd < 0) {
    return null;
  }

  const header = decoder.decode(bytes.subarray(0, headerEnd));
  const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
  const contentType = header.match(/Content-Type:\s*([^\r\n;]+)/i)?.[1].trim() ?? '';
  const bodyStart = headerEnd + HEADER_END.length;
  if (!Number.isFinite(length) || bytes.length < bodyStart + length) {
    return null;
  }

  const body = bytes.slice(bodyStart, bodyStart + length);
  const part = contentType === 'application/json' ? { event: JSON.parse(decoder.decode(body)) } : { frame: body };

  return { part, rest: bytes.subarray(bodyStart + length) };
}

// Collects stream chunks, which can split a part anywhere, and hands back
// complete parts.
export class StreamDecoder {
  #buffer = new Uint8Array(0);

  // Returns the parts completed by this chunk, oldest first: { frame } for a
  // live view JPEG, { event } for a server event.
  push(chunk) {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);

    const parts = [];
    let rest = joined;
    let taken = takePart(rest);
    while (taken !== null) {
      parts.push(taken.part);
      rest = taken.rest;
      taken = takePart(rest);
    }
    this.#buffer = rest.slice();

    return parts;
  }
}
