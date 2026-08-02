import {
  QRCode,
  generateSegmentsStructuredAppend,
  generateStructuredAppend,
  type QRSegmentInput
} from "specqr";

const segments = [
  { mode: "numeric", data: "1234567890" },
  { mode: "alphanumeric", data: "HELLO123" },
  { mode: "byte", data: "é😀Z".repeat(20) }
] satisfies QRSegmentInput[];

const standard = generateSegmentsStructuredAppend(segments, {
  version: 2,
  output: "matrix",
  diagnostics: true
});
const standardDetail: "summary" = standard.diagnostics.splitUnitsDetail;
const standardMatrixRow: boolean[] = standard.symbols[0].matrix[0];

const full = generateSegmentsStructuredAppend(segments, {
  version: 2,
  diagnostics: { splitUnits: "full" }
});
const fullDetail: "full" = full.diagnostics.splitUnitsDetail;
const fullByteStart: number = full.diagnostics.splitUnits[0].byteStart;
const fullDiagnosticRow: boolean[] = full.symbols[0].matrix[0];

const output = QRCode.generateSegmentsStructuredAppend(segments, {
  version: 2,
  output: "matrix",
  diagnostics: {
    splitUnits: "full",
    symbolResults: "output"
  }
});
const outputDetail: "full" = output.diagnostics.splitUnitsDetail;
const outputMatrixRow: boolean[] = output.symbols[0][0];

const staticDiagnostics = QRCode.generateSegmentsStructuredAppend(segments, {
  version: 2,
  diagnostics: {
    splitUnits: "summary",
    symbolResults: "diagnostics"
  }
});
const staticMatrixRow: boolean[] = staticDiagnostics.symbols[0].matrix[0];

// @ts-expect-error The raw Structured Append API does not own the manual diagnostics object.
generateStructuredAppend("RAW", { diagnostics: { splitUnits: "full" } });

void [
  standardDetail,
  standardMatrixRow,
  fullDetail,
  fullByteStart,
  fullDiagnosticRow,
  outputDetail,
  outputMatrixRow,
  staticMatrixRow
];
