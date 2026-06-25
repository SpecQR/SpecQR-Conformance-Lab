import {
  QRCode,
  createGs1DigitalLink,
  createGs1ElementString,
  estimate,
  generate,
  generateSegments,
  generateStructuredAppend,
  getCapacity,
  mergeStructuredAppendParts,
  type QRMatrix,
  type QRSegmentInput,
  type QRStructuredAppendDecodedPart
} from "specqr";
import {
  toBlob,
  toBlobFromSegments,
  toImageData,
  toImageDataFromSegments,
  toObjectURL,
  toObjectURLFromSegments
} from "specqr/browser";
import {
  toPngBuffer,
  toPngBufferFromSegments,
  writePngFile,
  writePngFileFromSegments
} from "specqr/node";

const segments: QRSegmentInput[] = [
  { mode: "alphanumeric", text: "SPECQR" },
  { mode: "byte", text: " types" }
];

const matrix: QRMatrix = generate("HELLO", {
  output: "matrix",
  errorCorrectionLevel: "M"
});
const segmentSvg: string = generateSegments(segments, {
  output: "svg",
  errorCorrectionLevel: "M"
});
const diagnostic = QRCode.generate("HELLO", {
  diagnostics: true
});

const plan = estimate("HELLO", {
  errorCorrectionLevel: "M"
});
const capacity = getCapacity({
  version: 1,
  errorCorrectionLevel: "M",
  mode: "byte"
});

const elementString: string = createGs1ElementString([
  { ai: "01", value: "04912345678904" }
]);
const digitalLink: string = createGs1DigitalLink([
  { ai: "01", value: "04912345678904" },
  { ai: "10", value: "ABC123" }
], {
  baseUrl: "https://id.gs1.org"
});

const structured = generateStructuredAppend("A".repeat(40), {
  maxSymbols: 2,
  output: "matrix"
});
const decodedParts: QRStructuredAppendDecodedPart<string>[] = [
  { index: 1, total: 1, parity: 65, data: "A" }
];
const merged = mergeStructuredAppendParts(decodedParts);

const blob: Blob = toBlob("HELLO");
const segmentBlob: Blob = toBlobFromSegments(segments);
const objectUrl: string = toObjectURL("HELLO");
const segmentObjectUrl: string = toObjectURLFromSegments(segments);
const imageData: ImageData = toImageData("HELLO");
const segmentImageData: ImageData = toImageDataFromSegments(segments);

const pngBuffer: Buffer = toPngBuffer("HELLO");
const segmentPngBuffer: Buffer = toPngBufferFromSegments(segments);
const writePng: Promise<void> = writePngFile("/tmp/specqr-types.png", "HELLO");
const writeSegmentsPng: Promise<void> = writePngFileFromSegments("/tmp/specqr-segments-types.png", segments);

export const smoke = {
  matrix,
  segmentSvg,
  diagnostic,
  planOk: plan.ok,
  capacityBytes: capacity.maxBytes,
  elementString,
  digitalLink,
  structuredTotal: structured.total,
  mergedData: merged.data,
  blob,
  segmentBlob,
  objectUrl,
  segmentObjectUrl,
  imageData,
  segmentImageData,
  pngBuffer,
  segmentPngBuffer,
  writePng,
  writeSegmentsPng
};
