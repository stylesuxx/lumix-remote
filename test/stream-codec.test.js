import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeEvent, encodeFrame, StreamDecoder } from '../src/shared/stream-codec.js';

test('frames and events survive being split across arbitrary chunks', () => {
  const frames = [new Uint8Array([0xff, 0xd8, 1, 2, 3]), new Uint8Array([0xff, 0xd8, 13, 10, 13, 10, 9])];
  const event = { type: 'capture', phase: 'done', name: 'P1100135' };
  const encodedParts = [encodeFrame(frames[0]), encodeEvent(event), encodeFrame(frames[1])];
  const stream = new Uint8Array(encodedParts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of encodedParts) {
    stream.set(part, offset);
    offset += part.length;
  }

  for (const chunkSize of [1, 3, 7, stream.length]) {
    const decoder = new StreamDecoder();
    const decoded = [];
    for (let start = 0; start < stream.length; start += chunkSize) {
      decoded.push(...decoder.push(stream.subarray(start, start + chunkSize)));
    }

    assert.deepEqual(decoded, [{ frame: frames[0] }, { event }, { frame: frames[1] }], `chunk size ${chunkSize}`);
  }
});
