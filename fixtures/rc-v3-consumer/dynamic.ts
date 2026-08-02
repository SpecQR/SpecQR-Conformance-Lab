import {
  QRCode,
  generateSegmentsStructuredAppend,
  type QRSegmentInput,
  type QRStructuredAppendSegmentsGenerateOptions
} from "specqr";

const segments: QRSegmentInput[] = [
  { mode: "byte", data: "DYNAMIC" }
];

function inspectDynamic(options: QRStructuredAppendSegmentsGenerateOptions) {
  const named = generateSegmentsStructuredAppend(segments, options);
  const staticResult = QRCode.generateSegmentsStructuredAppend(segments, options);

  if (named.diagnostics.splitUnitsDetail === "full") {
    const count: number = named.diagnostics.splitUnits.length;
    void count;
  }
  if (staticResult.diagnostics.splitUnitsDetail === "full") {
    const firstOffset: number | undefined = staticResult.diagnostics.splitUnits[0]?.byteStart;
    void firstOffset;
  }

  return [named, staticResult];
}

const dynamicOptions: QRStructuredAppendSegmentsGenerateOptions = Math.random() > 0.5
  ? { output: "matrix", diagnostics: { splitUnits: "summary", symbolResults: "output" } }
  : { diagnostics: { splitUnits: "full", symbolResults: "diagnostics" } };

void inspectDynamic(dynamicOptions);
