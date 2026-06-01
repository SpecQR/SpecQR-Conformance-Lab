import jsQR from "jsqr";
import { generate, generateSegments } from "specqr";
import { binaryHexToBytes, summarizeChecks } from "./specqr.js";
import { pngToRgba } from "../tools/png-rgba.js";

const supportedOperations = new Set(["generate", "generateSegments"]);

export function supportsOperation(operation) {
  return supportedOperations.has(operation);
}

function isStructuredAppendOperation(operation) {
  return typeof operation === "string" && operation.startsWith("structuredAppend.");
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

function normalizeInput(input) {
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

function normalizeSegments(segments) {
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

function pngOptions(options) {
  return {
    ...options,
    scale: options.scale ?? 12,
    margin: options.margin ?? 4,
    output: "png",
    diagnostics: false
  };
}

function generatePng(vector) {
  if (vector.operation === "generate") {
    return generate(normalizeInput(vector.input), pngOptions(vector.options));
  }

  return generateSegments(normalizeSegments(vector.input.segments), pngOptions(vector.options));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodePng(pngBytes) {
  const image = pngToRgba(pngBytes);
  const decoded = jsQR(image.rgba, image.width, image.height, {
    inversionAttempts: "dontInvert"
  });

  return {
    image: {
      width: image.width,
      height: image.height
    },
    decoded
  };
}

export function evaluateDecodeExpectation(expectDecode, decoded) {
  const checks = [];

  if (!decoded) {
    return [createFailedCheck("decode.read", "jsQR could not decode the generated PNG")];
  }

  if (Object.hasOwn(expectDecode, "text")) {
    if (decoded.data === expectDecode.text) {
      checks.push(createPassedCheck("decode.text"));
    } else {
      checks.push(createFailedCheck("decode.text", "decoded text differs", {
        expected: expectDecode.text,
        actual: decoded.data
      }));
    }
  }

  if (Object.hasOwn(expectDecode, "binaryHex")) {
    if (!Array.isArray(decoded.binaryData)) {
      checks.push(createSkippedCheck("decode.binaryHex", "jsQR result did not expose reliable raw byte data."));
    } else {
      const actualHex = bytesToHex(decoded.binaryData);
      const expectedHex = expectDecode.binaryHex.toLowerCase();
      if (actualHex === expectedHex) {
        checks.push(createPassedCheck("decode.binaryHex"));
      } else {
        checks.push(createFailedCheck("decode.binaryHex", "decoded raw bytes differ", {
          expected: expectedHex,
          actual: actualHex
        }));
      }
    }
  }

  if (checks.length === 0) {
    checks.push(createSkippedCheck("decode", "この decode expectation には jsQR lane が比較できる field がありません。"));
  }

  return checks;
}

export const adapter = {
  id: "jsqr",
  name: "jsQR",
  packageName: "jsqr",
  packageVersion: "1.4.0",
  status: "active",
  supportsOperation,
  async run(vector) {
    if (isStructuredAppendOperation(vector.operation)) {
      return {
        vectorId: vector.id,
        adapterId: "jsqr",
        status: "skipped",
        checks: [createSkippedCheck("operation", "jsQR lane は Structured Append metadata validation や decoder merge support を主張しません。")],
        reason: `Structured Append operation is outside jsQR decode-readability scope: ${vector.operation}`
      };
    }

    if (!supportsOperation(vector.operation)) {
      return {
        vectorId: vector.id,
        adapterId: "jsqr",
        status: "skipped",
        checks: [createSkippedCheck("operation", `jsQR lane は ${vector.operation} を対象外にします。`)],
        reason: `Unsupported operation for jsQR lane: ${vector.operation}`
      };
    }

    if (!Object.hasOwn(vector.expect, "decode")) {
      return {
        vectorId: vector.id,
        adapterId: "jsqr",
        status: "skipped",
        checks: [createSkippedCheck("decode", "decode expectation がないため jsQR lane は実行しません。")],
        reason: "No decode expectation"
      };
    }

    let decodedResult;
    try {
      decodedResult = decodePng(generatePng(vector));
    } catch (error) {
      return {
        vectorId: vector.id,
        adapterId: "jsqr",
        status: "error",
        checks: [{
          name: "decode",
          status: "error",
          reason: "jsQR lane failed while generating or decoding PNG",
          error: {
            name: error.name ?? "Error",
            message: error.message ?? String(error)
          }
        }],
        reason: "jsQR lane failed while generating or decoding PNG"
      };
    }

    const checks = evaluateDecodeExpectation(vector.expect.decode, decodedResult.decoded);
    const status = summarizeChecks(checks);

    return {
      vectorId: vector.id,
      adapterId: "jsqr",
      status,
      checks,
      ...(status === "failed" ? { reason: "one or more decode checks failed" } : {}),
      details: {
        image: decodedResult.image,
        decoded: decodedResult.decoded ? {
          text: decodedResult.decoded.data,
          binaryHex: Array.isArray(decodedResult.decoded.binaryData) ? bytesToHex(decodedResult.decoded.binaryData) : null,
          version: decodedResult.decoded.version,
          chunks: decodedResult.decoded.chunks
        } : null
      }
    };
  }
};

export default adapter;
