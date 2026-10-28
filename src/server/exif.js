// Reads the camera model and firmware from a JPEG's EXIF data (IFD0 tags
// Model and Software), from the first 128 KB of the file.
import { open } from 'node:fs/promises';

const HEAD_BYTES = 128 * 1024;
const MODEL_TAG = 0x0110;
const SOFTWARE_TAG = 0x0131;
const ASCII_TYPE = 2;

// The TIFF block inside the APP1 Exif segment, or null.
function findTiff(bytes) {
  if (bytes.readUInt16BE(0) !== 0xffd8) {
    return null;
  }

  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    const isExif = marker === 0xe1 && bytes.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0';
    if (isExif) {
      return bytes.subarray(offset + 10, offset + 2 + length);
    }

    offset += 2 + length;
  }

  return null;
}

// ASCII tags of IFD0 as a Map from tag number to trimmed text.
function readIfd0Text(tiff) {
  const isLittleEndian = tiff.toString('latin1', 0, 2) === 'II';
  const readUInt16 = (at) => (isLittleEndian ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const readUInt32 = (at) => (isLittleEndian ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));

  const texts = new Map();
  const ifdOffset = readUInt32(4);
  const entryCount = readUInt16(ifdOffset);
  for (let entry = 0; entry < entryCount; entry++) {
    const at = ifdOffset + 2 + entry * 12;
    if (readUInt16(at + 2) !== ASCII_TYPE) {
      continue;
    }

    const count = readUInt32(at + 4);
    const valueOffset = count <= 4 ? at + 8 : readUInt32(at + 8);
    const text = tiff.toString('latin1', valueOffset, valueOffset + count).replace(/\0.*$/s, '').trim();
    texts.set(readUInt16(at), text);
  }

  return texts;
}

// { model, firmware } for a JPEG written by the camera, or null when the file
// has no readable EXIF block. Panasonic writes Software as "Ver.2.2".
export function parseCameraInfo(bytes) {
  try {
    const tiff = findTiff(bytes);
    if (tiff === null) {
      return null;
    }

    const texts = readIfd0Text(tiff);
    const model = texts.get(MODEL_TAG) ?? null;
    const firmware = texts.get(SOFTWARE_TAG)?.replace(/^Ver\.?\s*/i, '') ?? null;

    return model || firmware ? { model, firmware } : null;
  } catch {
    return null;
  }
}

export async function readCameraInfo(filePath) {
  const file = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(head, 0, HEAD_BYTES, 0);

    return parseCameraInfo(head.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}
