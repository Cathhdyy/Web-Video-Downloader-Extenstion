const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(width, height, getPixelColor) {
  // RGBA raw buffer with scanline filter byte (0 = None) at the start of each row
  const rowSize = width * 4 + 1;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    rawData[rowStart] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixelColor(x, y, width, height);
      const pixelStart = rowStart + 1 + x * 4;
      rawData[pixelStart] = r;
      rawData[pixelStart + 1] = g;
      rawData[pixelStart + 2] = b;
      rawData[pixelStart + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);

  // PNG Header
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 6; // Color type (RGBA)
  ihdr[10] = 0; // Compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace

  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', compressedData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = data.length;
  const buffer = Buffer.alloc(4 + 4 + length + 4);
  buffer.writeUInt32BE(length, 0);
  buffer.write(type, 4);
  data.copy(buffer, 8);

  const crcTarget = buffer.subarray(4, 8 + length);
  const crcVal = crc32(crcTarget);
  buffer.writeUInt32BE(crcVal, 8 + length);
  return buffer;
}

// CRC32 implementation
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1);
    } else {
      c = c >>> 1;
    }
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function drawIconPixel(x, y, w, h) {
  // Normalize coordinates (-1 to 1)
  const nx = (x / w) * 2 - 1;
  const ny = (y / h) * 2 - 1;
  const radiusCorner = 0.28;

  // Rounded rectangle SDF
  const bx = Math.abs(nx) - (1 - radiusCorner);
  const by = Math.abs(ny) - (1 - radiusCorner);
  const d = Math.min(Math.max(bx, by), 0.0) + Math.sqrt(Math.max(bx, 0) ** 2 + Math.max(by, 0) ** 2) - radiusCorner;

  if (d > 0.05) {
    return [0, 0, 0, 0]; // Transparent background
  }

  // Smooth anti-aliased edge
  const edgeAlpha = Math.min(Math.max(1.0 - d / 0.05, 0.0), 1.0);

  // Gradient background: Violet (#7C4DFF -> rgb(124, 77, 255)) to Cyan (#00E5FF -> rgb(0, 229, 255))
  const t = (nx + ny + 2) / 4;
  let r = Math.round(124 * (1 - t) + 0 * t);
  let g = Math.round(77 * (1 - t) + 229 * t);
  let b = Math.round(255 * (1 - t) + 255 * t);

  // Arrow / Download glyph in center
  const arrowX = nx;
  const arrowY = ny;

  // Arrow shaft: vertical line from y = -0.45 to y = 0.2, thickness 0.12
  const inShaft = Math.abs(arrowX) < 0.09 && arrowY >= -0.45 && arrowY <= 0.2;

  // Arrow head: triangle pointing down from y = 0.0 to y = 0.35
  const headSlope = (0.35 - arrowY) * 1.0;
  const inHead = arrowY >= 0.0 && arrowY <= 0.35 && Math.abs(arrowX) <= (0.35 - arrowY) * 0.9 && Math.abs(arrowX) >= (0.35 - arrowY) * 0.9 - 0.25;

  // Tray line at bottom: y = 0.55, width from x = -0.5 to 0.5, thickness 0.1
  const inTray = Math.abs(arrowY - 0.55) < 0.07 && Math.abs(arrowX) < 0.5;

  if (inShaft || inHead || inTray) {
    // Pure White Arrow
    r = 255;
    g = 255;
    b = 255;
  }

  return [r, g, b, Math.round(255 * edgeAlpha)];
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach((size) => {
  const pngBuf = createPng(size, size, drawIconPixel);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, pngBuf);
  console.log(`Generated: ${outPath} (${pngBuf.length} bytes)`);
});
