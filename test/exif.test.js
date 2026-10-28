import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCameraInfo } from '../src/server/exif.js';

// A JPEG holding only an APP1 Exif segment whose IFD0 has the given ASCII tags.
function jpegWithTags(tags, isLittleEndian = true) {
  const strings = tags.map(([, text]) => Buffer.from(`${text}\0`, 'latin1'));
  const ifdSize = 2 + tags.length * 12 + 4;
  const tiff = Buffer.alloc(8 + ifdSize + strings.reduce((size, string) => size + string.length, 0));
  const writeUInt16 = (value, at) => (isLittleEndian ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const writeUInt32 = (value, at) => (isLittleEndian ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));

  tiff.write(isLittleEndian ? 'II' : 'MM', 0, 'latin1');
  writeUInt16(42, 2);
  writeUInt32(8, 4);
  writeUInt16(tags.length, 8);
  let stringOffset = 8 + ifdSize;
  tags.forEach(([tag], index) => {
    const at = 10 + index * 12;
    writeUInt16(tag, at);
    writeUInt16(2, at + 2);
    writeUInt32(strings[index].length, at + 4);
    writeUInt32(stringOffset, at + 8);
    strings[index].copy(tiff, stringOffset);
    stringOffset += strings[index].length;
  });

  const segment = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(segment.length + 2, 4);

  return Buffer.concat([header, segment]);
}

test('reads model and firmware from IFD0 in either byte order', () => {
  const tags = [[0x0110, 'DMC-G70'], [0x0131, 'Ver.2.2  ']];

  assert.deepEqual(parseCameraInfo(jpegWithTags(tags, true)), { model: 'DMC-G70', firmware: '2.2' });
  assert.deepEqual(parseCameraInfo(jpegWithTags(tags, false)), { model: 'DMC-G70', firmware: '2.2' });
});

test('answers null for files without readable EXIF', () => {
  assert.equal(parseCameraInfo(Buffer.from('not a jpeg at all')), null);
  assert.equal(parseCameraInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(parseCameraInfo(jpegWithTags([[0x010f, 'Panasonic']])), null);
});
