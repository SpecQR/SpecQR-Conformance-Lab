import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { generate, generateSegments } from "specqr";
import { binaryHexToBytes } from "./specqr.js";

const supportedOperations = new Set(["generate", "generateSegments"]);
const textEncoder = new TextEncoder();
const require = createRequire(import.meta.url);
let nayukiPromise = null;

async function loadNayuki() {
  if (!nayukiPromise) {
    nayukiPromise = import("nayuki-qr-code-generator")
      .then((module) => module.default ?? module)
      .catch(async () => {
        const packagePath = require.resolve("nayuki-qr-code-generator");
        const source = await readFile(packagePath, "utf8");
        const encoded = Buffer.from(source, "utf8").toString("base64");
        const module = await import(`data:text/javascript;base64,${encoded}`);
        return module.default ?? module;
      });
  }

  return nayukiPromise;
}

function eccMap(QrCode) {
  return {
    L: QrCode.Ecc.LOW,
    M: QrCode.Ecc.MEDIUM,
    Q: QrCode.Ecc.QUARTILE,
    H: QrCode.Ecc.HIGH
  };
}

export function supportsOperation(operation) {
  return supportedOperations.has(operation);
}

function isStructuredAppendOperation(operation) {
  return typeof operation === "string" && operation.startsWith("structuredAppend.");
}

export function matrixRows(matrix) {
  return matrix.map((row) => row.map((module) => (module ? "1" : "0")).join(""));
}

export function matrixSha256(rows) {
  return createHash("sha256").update(rows.join("\n"), "utf8").digest("hex");
}

export function compareMatrixRows(expectedRows, actualRows) {
  if (expectedRows.length !== actualRows.length) {
    return {
      ok: false,
      firstMismatch: {
        reason: "size differs",
        expectedSize: expectedRows.length,
        actualSize: actualRows.length
      }
    };
  }

  for (let y = 0; y < expectedRows.length; y += 1) {
    if (expectedRows[y] === actualRows[y]) {
      continue;
    }

    const width = Math.max(expectedRows[y].length, actualRows[y].length);
    for (let x = 0; x < width; x += 1) {
      if (expectedRows[y][x] !== actualRows[y][x]) {
        return {
          ok: false,
          firstMismatch: {
            x,
            y,
            expected: expectedRows[y][x] ?? null,
            actual: actualRows[y][x] ?? null,
            expectedRow: expectedRows[y],
            actualRow: actualRows[y]
          }
        };
      }
    }
  }

  return { ok: true };
}

function createSkippedCheck(name, reason) {
  return {
    name,
    status: "skipped",
    reason
  };
}

function createPassedCheck(name, details = {}) {
  return {
    name,
    status: "passed",
    ...details
  };
}

function createFailedCheck(name, reason, details = {}) {
  return {
    name,
    status: "failed",
    reason,
    ...details
  };
}

function bytesFromText(text) {
  return Array.from(textEncoder.encode(text));
}

function bytesFromInput(input) {
  if (Object.hasOwn(input, "binaryHex")) {
    return Array.from(binaryHexToBytes(input.binaryHex));
  }

  if (Object.hasOwn(input, "bytes")) {
    return Array.from(input.bytes);
  }

  return bytesFromText(input.text ?? input.data ?? "");
}

function textFromInput(input) {
  return input.text ?? input.data ?? "";
}

function normalizeSpecqrInput(input) {
  if (Object.hasOwn(input, "binaryHex")) {
    return binaryHexToBytes(input.binaryHex);
  }

  if (Object.hasOwn(input, "text")) {
    return input.text;
  }

  if (Object.hasOwn(input, "data")) {
    return input.data;
  }

  return input;
}

function normalizeSpecqrSegments(segments) {
  return segments.map((segment) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      return segment;
    }

    if (!Object.hasOwn(segment, "binaryHex")) {
      return { ...segment };
    }

    const { binaryHex, ...rest } = segment;
    return {
      ...rest,
      bytes: binaryHexToBytes(binaryHex)
    };
  });
}

function hasReferenceMatrix(vector) {
  return vector.expect?.referenceMatrix?.adapter === "nayuki";
}

function validateFixedCondition(vector, QrCode) {
  if (!Number.isInteger(vector.options.version) || vector.options.version < 1 || vector.options.version > 40) {
    return "Nayuki reference lane requires fixed options.version 1..40.";
  }

  if (!eccMap(QrCode)[vector.options.errorCorrectionLevel]) {
    return "Nayuki reference lane requires fixed options.errorCorrectionLevel L/M/Q/H.";
  }

  if (!Number.isInteger(vector.options.maskPattern) || vector.options.maskPattern < 0 || vector.options.maskPattern > 7) {
    return "Nayuki reference lane requires fixed options.maskPattern 0..7.";
  }

  return null;
}

function hasUnsupportedOptions(vector) {
  if (vector.options.gs1 || vector.options.fnc1Second || vector.options.structuredAppend) {
    return "GS1/FNC1/Structured Append は Nayuki fixed matrix lane の対象外です。";
  }

  if (vector.options.eci && vector.options.eci !== true && vector.options.eci !== 26) {
    return "Nayuki fixed matrix lane は ECI 26 のみ対応します。";
  }

  return null;
}

function prependEciIfNeeded(segments, options, QrSegment) {
  if (options.eci === true || options.eci === 26) {
    return [QrSegment.makeEci(26), ...segments];
  }
  return segments;
}

function nayukiSegmentFromManual(segment, QrSegment) {
  if (segment.mode === "numeric") {
    return QrSegment.makeNumeric(textFromInput(segment));
  }

  if (segment.mode === "alphanumeric") {
    return QrSegment.makeAlphanumeric(textFromInput(segment));
  }

  if (segment.mode === "byte") {
    return QrSegment.makeBytes(bytesFromInput(segment));
  }

  throw new Error(`Unsupported manual segment mode for Nayuki lane: ${segment.mode}`);
}

function nayukiSegmentsForVector(vector, QrSegment) {
  if (vector.operation === "generateSegments") {
    const unsupported = vector.input.segments.find((segment) => !["numeric", "alphanumeric", "byte"].includes(segment.mode));
    if (unsupported) {
      return { skipped: `Nayuki fixed matrix lane does not support segment mode ${unsupported.mode}.` };
    }

    return {
      segments: prependEciIfNeeded(vector.input.segments.map((segment) => nayukiSegmentFromManual(segment, QrSegment)), vector.options, QrSegment)
    };
  }

  if (Object.hasOwn(vector.input, "binaryHex")) {
    return {
      segments: prependEciIfNeeded([QrSegment.makeBytes(bytesFromInput(vector.input))], vector.options, QrSegment)
    };
  }

  if (vector.options.mode === "numeric") {
    return {
      segments: prependEciIfNeeded([QrSegment.makeNumeric(textFromInput(vector.input))], vector.options, QrSegment)
    };
  }

  if (vector.options.mode === "alphanumeric") {
    return {
      segments: prependEciIfNeeded([QrSegment.makeAlphanumeric(textFromInput(vector.input))], vector.options, QrSegment)
    };
  }

  if (vector.options.mode === "byte") {
    return {
      segments: prependEciIfNeeded([QrSegment.makeBytes(bytesFromInput(vector.input))], vector.options, QrSegment)
    };
  }

  return {
    skipped: "Nayuki fixed matrix lane does not claim auto segmentation equivalence; set options.mode or use generateSegments."
  };
}

function generateSpecqrMatrix(vector) {
  const options = {
    ...vector.options,
    output: "matrix",
    diagnostics: true,
    boostErrorCorrection: vector.options.boostErrorCorrection ?? false
  };

  if (vector.operation === "generate") {
    return generate(normalizeSpecqrInput(vector.input), options);
  }

  return generateSegments(normalizeSpecqrSegments(vector.input.segments), options);
}

function generateNayukiMatrix(vector, segments, QrCode) {
  const qr = QrCode.encodeSegments(
    segments,
    eccMap(QrCode)[vector.options.errorCorrectionLevel],
    vector.options.version,
    vector.options.version,
    vector.options.maskPattern,
    false
  );

  const rows = Array.from({ length: qr.size }, (_, y) => {
    return Array.from({ length: qr.size }, (_, x) => (qr.getModule(x, y) ? "1" : "0")).join("");
  });

  return {
    qr,
    rows
  };
}

export const adapter = {
  id: "nayuki",
  name: "Nayuki QR Code generator",
  packageName: "nayuki-qr-code-generator",
  packageVersion: "1.8.0",
  status: "active",
  supportsOperation,
  async run(vector) {
    if (isStructuredAppendOperation(vector.operation)) {
      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "skipped",
        checks: [createSkippedCheck("referenceMatrix.scope", "Structured Append は Nayuki fixed matrix lane の対象外です。")],
        reason: `Structured Append is outside Nayuki fixed matrix scope: ${vector.operation}`
      };
    }

    if (!supportsOperation(vector.operation)) {
      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "skipped",
        checks: [createSkippedCheck("operation", `Nayuki reference lane は ${vector.operation} を対象外にします。`)],
        reason: `Unsupported operation for Nayuki lane: ${vector.operation}`
      };
    }

    if (!hasReferenceMatrix(vector)) {
      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "skipped",
        checks: [createSkippedCheck("referenceMatrix", "expect.referenceMatrix.adapter が nayuki ではないため実行しません。")],
        reason: "No Nayuki referenceMatrix expectation"
      };
    }

    const qrcodegen = await loadNayuki();
    const { QrCode, QrSegment } = qrcodegen;
    const fixedConditionReason = validateFixedCondition(vector, QrCode);
    if (fixedConditionReason) {
      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "skipped",
        checks: [createSkippedCheck("referenceMatrix.fixedCondition", fixedConditionReason)],
        reason: fixedConditionReason
      };
    }

    const unsupportedReason = hasUnsupportedOptions(vector);
    if (unsupportedReason) {
      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "skipped",
        checks: [createSkippedCheck("referenceMatrix.scope", unsupportedReason)],
        reason: unsupportedReason
      };
    }

    const segmentResult = nayukiSegmentsForVector(vector, QrSegment);
    if (segmentResult.skipped) {
      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "skipped",
        checks: [createSkippedCheck("referenceMatrix.scope", segmentResult.skipped)],
        reason: segmentResult.skipped
      };
    }

    try {
      const specqr = generateSpecqrMatrix(vector);
      const specqrRows = matrixRows(specqr.matrix);
      const nayuki = generateNayukiMatrix(vector, segmentResult.segments, QrCode);
      const comparison = compareMatrixRows(nayuki.rows, specqrRows);
      const specqrHash = matrixSha256(specqrRows);
      const nayukiHash = matrixSha256(nayuki.rows);
      const details = {
        matrixSha256: specqrHash,
        specqrMatrixSha256: specqrHash,
        nayukiMatrixSha256: nayukiHash,
        version: specqr.diagnostics.version,
        size: specqr.matrix.length,
        errorCorrectionLevel: specqr.diagnostics.errorCorrectionLevel,
        maskPattern: specqr.diagnostics.maskPattern,
        nayuki: {
          version: nayuki.qr.version,
          size: nayuki.qr.size,
          errorCorrectionLevel: vector.options.errorCorrectionLevel,
          maskPattern: nayuki.qr.mask
        },
        ...(comparison.firstMismatch ? { firstMismatch: comparison.firstMismatch } : {})
      };

      if (comparison.ok) {
        return {
          vectorId: vector.id,
          adapterId: "nayuki",
          status: "passed",
          checks: [createPassedCheck("referenceMatrix.exact", details)],
          details
        };
      }

      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "failed",
        checks: [createFailedCheck("referenceMatrix.exact", "SpecQR matrix differs from Nayuki matrix", details)],
        reason: "SpecQR matrix differs from Nayuki matrix",
        details
      };
    } catch (error) {
      return {
        vectorId: vector.id,
        adapterId: "nayuki",
        status: "error",
        checks: [{
          name: "referenceMatrix.exact",
          status: "error",
          reason: "Nayuki reference lane failed while generating or comparing matrix",
          error: {
            name: error.name ?? "Error",
            message: error.message ?? String(error)
          }
        }],
        reason: "Nayuki reference lane failed while generating or comparing matrix"
      };
    }
  }
};

export default adapter;
