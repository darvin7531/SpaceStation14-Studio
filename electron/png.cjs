const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_RSI_PNG_BYTES = 8 * 1024 * 1024;

function inspectPng(buffer, maxBytes = MAX_RSI_PNG_BYTES) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > maxBytes) {
    throw new Error(`PNG must be between 24 bytes and ${maxBytes} bytes.`);
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('File is not a valid PNG with an IHDR header.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw new Error('PNG width and height must be positive.');
  return { width, height };
}

function assertRsiSheetDimensions(dimensions, size) {
  const x = Number(size?.x);
  const y = Number(size?.y);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1) {
    throw new Error('RSI size must contain positive integer x and y values.');
  }
  if (dimensions.width % x !== 0 || dimensions.height % y !== 0) {
    throw new Error(`PNG ${dimensions.width}x${dimensions.height} is incompatible with RSI tile size ${x}x${y}.`);
  }
}

module.exports = { MAX_RSI_PNG_BYTES, inspectPng, assertRsiSheetDimensions };
