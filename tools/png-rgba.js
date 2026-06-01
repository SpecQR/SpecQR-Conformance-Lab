import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32(buffer, offset) {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  ) >>> 0;
}

function ascii(buffer, start, end) {
  return String.fromCharCode(...buffer.slice(start, end));
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  if (upDistance <= upLeftDistance) {
    return up;
  }
  return upLeft;
}

function bytesPerPixel(colorType) {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 6:
      return 4;
    default:
      throw new Error(`Unsupported PNG color type: ${colorType}`);
  }
}

function unfilterScanlines(inflated, width, height, bpp) {
  const stride = width * bpp;
  const expectedLength = (stride + 1) * height;
  if (inflated.length !== expectedLength) {
    throw new Error(`Unexpected PNG data length: expected ${expectedLength}, got ${inflated.length}`);
  }

  const raw = new Uint8Array(stride * height);
  let sourceOffset = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = row * stride;
    const previousRowOffset = rowOffset - stride;

    for (let column = 0; column < stride; column += 1) {
      const value = inflated[sourceOffset + column];
      const left = column >= bpp ? raw[rowOffset + column - bpp] : 0;
      const up = row > 0 ? raw[previousRowOffset + column] : 0;
      const upLeft = row > 0 && column >= bpp ? raw[previousRowOffset + column - bpp] : 0;

      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + Math.floor((left + up) / 2);
          break;
        case 4:
          reconstructed = value + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error(`Unsupported PNG filter type: ${filter}`);
      }

      raw[rowOffset + column] = reconstructed & 0xff;
    }

    sourceOffset += stride;
  }

  return raw;
}

function toRgba(raw, width, height, colorType) {
  if (colorType === 6) {
    return new Uint8ClampedArray(raw);
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const bpp = bytesPerPixel(colorType);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceOffset = pixel * bpp;
    const targetOffset = pixel * 4;

    if (colorType === 0) {
      const gray = raw[sourceOffset];
      rgba[targetOffset] = gray;
      rgba[targetOffset + 1] = gray;
      rgba[targetOffset + 2] = gray;
      rgba[targetOffset + 3] = 255;
    } else {
      rgba[targetOffset] = raw[sourceOffset];
      rgba[targetOffset + 1] = raw[sourceOffset + 1];
      rgba[targetOffset + 2] = raw[sourceOffset + 2];
      rgba[targetOffset + 3] = 255;
    }
  }

  return rgba;
}

export function pngToRgba(pngBytes) {
  const buffer = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);

  for (const [index, byte] of PNG_SIGNATURE.entries()) {
    if (buffer[index] !== byte) {
      throw new Error("Invalid PNG signature");
    }
  }

  let offset = PNG_SIGNATURE.length;
  let width = null;
  let height = null;
  let bitDepth = null;
  let colorType = null;
  let interlace = null;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = readUint32(buffer, offset);
    const type = ascii(buffer, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) {
      throw new Error(`Truncated PNG chunk: ${type}`);
    }

    const data = buffer.slice(dataStart, dataEnd);
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!width || !height) {
    throw new Error("PNG is missing IHDR");
  }
  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  }
  if (interlace !== 0) {
    throw new Error("Interlaced PNG is not supported");
  }
  if (idatChunks.length === 0) {
    throw new Error("PNG is missing IDAT data");
  }

  const compressedLength = idatChunks.reduce((total, chunk) => total + chunk.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.length;
  }

  const bpp = bytesPerPixel(colorType);
  const raw = unfilterScanlines(inflateSync(compressed), width, height, bpp);
  return {
    width,
    height,
    rgba: toRgba(raw, width, height, colorType)
  };
}

export default pngToRgba;
