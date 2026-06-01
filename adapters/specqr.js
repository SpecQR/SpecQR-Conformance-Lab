import { createHash } from "node:crypto";
import {
  analyzeSegments,
  createGs1DigitalLink,
  createGs1ElementString,
  estimate,
  generate,
  generateSegments,
  generateSegmentsStructuredAppend,
  generateStructuredAppend,
  getCapacity,
  mergeStructuredAppendParts,
  normalizeGs1DigitalLink,
  validateGs1DigitalLink,
  validateGs1ElementString
} from "specqr";

const supportedOperations = new Set([
  "generate",
  "generateSegments",
  "estimate",
  "analyzeSegments",
  "getCapacity",
  "gs1.createElementString",
  "gs1.validateElementString",
  "gs1.createDigitalLink",
  "gs1.validateDigitalLink",
  "gs1.normalizeDigitalLink",
  "structuredAppend.generate",
  "structuredAppend.generateSegments",
  "structuredAppend.mergeParts"
]);

export function supportsOperation(operation) {
  return supportedOperations.has(operation);
}

export function binaryHexToBytes(binaryHex) {
  if (typeof binaryHex !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(binaryHex)) {
    throw new Error("binaryHex must be an even-length hex string");
  }

  const bytes = new Uint8Array(binaryHex.length / 2);
  for (let index = 0; index < binaryHex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(binaryHex.slice(index, index + 2), 16);
  }
  return bytes;
}

export function deepSubsetMatch(expected, actual, path = "$") {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return { ok: false, path, expected, actual, reason: "actual is not an array" };
    }

    if (expected.length > actual.length) {
      return { ok: false, path, expected, actual, reason: "actual array is shorter than expected subset" };
    }

    for (const [index, expectedItem] of expected.entries()) {
      const result = deepSubsetMatch(expectedItem, actual[index], `${path}[${index}]`);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }

  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return { ok: false, path, expected, actual, reason: "actual is not an object" };
    }

    for (const [key, expectedValue] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) {
        return { ok: false, path: `${path}.${key}`, expected: expectedValue, actual: undefined, reason: "missing key" };
      }

      const result = deepSubsetMatch(expectedValue, actual[key], `${path}.${key}`);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }

  if (!Object.is(expected, actual)) {
    return { ok: false, path, expected, actual, reason: "values differ" };
  }

  return { ok: true };
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

function generationOptions(options) {
  return {
    ...options,
    output: options.output ?? "matrix",
    diagnostics: options.diagnostics ?? true
  };
}

function structuredAppendOptions(options) {
  return {
    ...options,
    output: options.output ?? "matrix",
    diagnostics: options.diagnostics ?? true
  };
}

function normalizeStructuredAppendParts(parts) {
  return parts.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return part;
    }

    if (!Object.hasOwn(part, "binaryHex")) {
      return { ...part };
    }

    const { binaryHex, ...rest } = part;
    return {
      ...rest,
      data: binaryHexToBytes(binaryHex)
    };
  });
}

function executeOperation(vector) {
  switch (vector.operation) {
    case "generate":
      return generate(normalizeInput(vector.input), generationOptions(vector.options));
    case "generateSegments":
      return generateSegments(normalizeSegments(vector.input.segments), generationOptions(vector.options));
    case "estimate":
      return estimate(normalizeInput(vector.input), vector.options);
    case "analyzeSegments":
      return analyzeSegments(normalizeSegments(vector.input.segments), vector.options);
    case "getCapacity":
      return getCapacity(vector.input);
    case "gs1.createElementString":
      return createGs1ElementString(vector.input.elements);
    case "gs1.validateElementString":
      return validateGs1ElementString(vector.input.elementString, vector.options);
    case "gs1.createDigitalLink":
      return createGs1DigitalLink(vector.input.elements ?? vector.input.parseResult ?? vector.input, vector.options);
    case "gs1.validateDigitalLink":
      return validateGs1DigitalLink(vector.input.url, vector.options);
    case "gs1.normalizeDigitalLink":
      return normalizeGs1DigitalLink(vector.input.url, vector.options);
    case "structuredAppend.generate":
      return generateStructuredAppend(normalizeInput(vector.input), structuredAppendOptions(vector.options));
    case "structuredAppend.generateSegments":
      return generateSegmentsStructuredAppend(normalizeSegments(vector.input.segments), structuredAppendOptions(vector.options));
    case "structuredAppend.mergeParts":
      return mergeStructuredAppendParts(normalizeStructuredAppendParts(vector.input.parts), vector.options);
    default:
      throw new Error(`Unsupported SpecQR operation: ${vector.operation}`);
  }
}

function errorDetails(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name ?? error.constructor?.name ?? "Error",
    code: error.code ?? null,
    message: error.message ?? String(error)
  };
}

function rejectionDetails(execution) {
  if (execution.error) {
    return {
      kind: "thrown",
      reason: null,
      error: errorDetails(execution.error)
    };
  }

  if (execution.actual && typeof execution.actual === "object" && execution.actual.ok === false) {
    return {
      kind: "result",
      reason: execution.actual.reason ?? null,
      error: execution.actual.error ?? null
    };
  }

  return null;
}

function checkResult(name, result, extra = {}) {
  return {
    name,
    status: result.ok ? "passed" : "failed",
    ...extra,
    ...(result.ok ? {} : {
      path: result.path,
      expected: result.expected,
      actual: result.actual,
      reason: result.reason
    })
  };
}

function containsSubset(expectedItem, actualItems, path) {
  if (!Array.isArray(actualItems)) {
    return {
      ok: false,
      path,
      expected: expectedItem,
      actual: actualItems,
      reason: "actual is not an array"
    };
  }

  for (const [index, actualItem] of actualItems.entries()) {
    const result = deepSubsetMatch(expectedItem, actualItem, `${path}[${index}]`);
    if (result.ok) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    path,
    expected: expectedItem,
    actual: actualItems,
    reason: "expected subset was not found in actual array"
  };
}

function createSkippedCheck(name, reason) {
  return {
    name,
    status: "skipped",
    reason
  };
}

function matrixToRowMajorBitString(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0 || !Array.isArray(matrix[0])) {
    throw new Error("matrix must be a non-empty boolean[][]");
  }

  return matrix.map((row) => row.map((module) => (module ? "1" : "0")).join("")).join("\n");
}

export function matrixHash(matrix, expectation = {}) {
  const algorithm = expectation.algorithm ?? "sha256";
  const encoding = expectation.encoding ?? "row-major-bits";

  if (algorithm !== "sha256") {
    throw new Error(`Unsupported matrix hash algorithm: ${algorithm}`);
  }

  if (encoding !== "row-major-bits") {
    throw new Error(`Unsupported matrix hash encoding: ${encoding}`);
  }

  return createHash("sha256").update(matrixToRowMajorBitString(matrix), "utf8").digest("hex");
}

function getActualDiagnostics(actual) {
  if (!actual || typeof actual !== "object") {
    return null;
  }

  return actual.diagnostics ?? null;
}

function selectedVersion(actual) {
  if (!actual || typeof actual !== "object") {
    return undefined;
  }

  return actual.selectedVersion ?? actual.version ?? actual.diagnostics?.version;
}

function actualPlanningField(actual, key) {
  if (key === "fits") {
    return actual?.ok;
  }

  if (key === "minimumVersion") {
    return selectedVersion(actual);
  }

  if (actual && typeof actual === "object" && Object.hasOwn(actual, key)) {
    return actual[key];
  }

  if (actual?.diagnostics && Object.hasOwn(actual.diagnostics, key)) {
    return actual.diagnostics[key];
  }

  return undefined;
}

function evaluatePlanningExpectation(expected, actual) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === "diagnostics" && expectedValue && typeof expectedValue === "object" && Object.hasOwn(expectedValue, "subset")) {
      const result = deepSubsetMatch(expectedValue.subset, actual?.diagnostics, "$.planning.diagnostics");
      if (!result.ok) {
        return result;
      }
      continue;
    }

    if (key === "warnings") {
      if (!Array.isArray(expectedValue)) {
        return {
          ok: false,
          path: "$.planning.warnings",
          expected: "array",
          actual: expectedValue,
          reason: "planning warnings expectation must be an array"
        };
      }

      const actualWarnings = actual?.warnings ?? actual?.diagnostics?.warnings;
      for (const expectedWarning of expectedValue) {
        const result = containsSubset(expectedWarning, actualWarnings, "$.planning.warnings");
        if (!result.ok) {
          return result;
        }
      }
      continue;
    }

    const actualValue = actualPlanningField(actual, key);

    if (key === "minimumVersion") {
      if (typeof actualValue !== "number" || actualValue < expectedValue) {
        return {
          ok: false,
          path: `$.planning.${key}`,
          expected: `>= ${expectedValue}`,
          actual: actualValue,
          reason: "selected version is below the expected minimum"
        };
      }
      continue;
    }

    const result = deepSubsetMatch(expectedValue, actualValue, `$.planning.${key}`);
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true };
}

function evaluateRejectsExpectation(expected, execution) {
  const rejection = rejectionDetails(execution);
  if (!rejection) {
    return {
      ok: false,
      path: "$.rejects",
      expected,
      actual: null,
      reason: "operation did not reject or return a non-throwing failure"
    };
  }

  const actualCode = rejection.error?.code ?? rejection.error?.name ?? rejection.reason;
  if (expected.code && expected.code !== actualCode) {
    return {
      ok: false,
      path: "$.rejects.code",
      expected: expected.code,
      actual: actualCode,
      reason: "rejection code differs"
    };
  }

  if (expected.reason && expected.reason !== rejection.reason) {
    return {
      ok: false,
      path: "$.rejects.reason",
      expected: expected.reason,
      actual: rejection.reason,
      reason: "rejection reason differs"
    };
  }

  if (expected.messageIncludes) {
    const message = rejection.error?.message ?? "";
    if (!message.includes(expected.messageIncludes)) {
      return {
        ok: false,
        path: "$.rejects.messageIncludes",
        expected: expected.messageIncludes,
        actual: message,
        reason: "rejection message does not include expected text"
      };
    }
  }

  return { ok: true };
}

function evaluateGs1Expectation(expected, actual) {
  const checks = [];

  if (Object.hasOwn(expected, "elementString")) {
    checks.push(deepSubsetMatch(expected.elementString, actual, "$.gs1.elementString"));
  }

  if (Object.hasOwn(expected, "digitalLink")) {
    checks.push(deepSubsetMatch(expected.digitalLink, actual, "$.gs1.digitalLink"));
  }

  if (Object.hasOwn(expected, "normalized")) {
    checks.push(deepSubsetMatch(expected.normalized, actual, "$.gs1.normalized"));
  }

  if (Object.hasOwn(expected, "validationSubset")) {
    checks.push(deepSubsetMatch(expected.validationSubset, actual, "$.gs1.validationSubset"));
  }

  for (const result of checks) {
    if (!result.ok) {
      return result;
    }
  }

  if (checks.length > 0) {
    return { ok: true };
  }

  return {
    ok: false,
    path: "$.gs1",
    expected,
    actual,
    reason: "unsupported gs1 expectation"
  };
}

function evaluateStructuredAppendExpectation(expected, actual) {
  const checks = [];

  for (const field of ["total", "parity", "byteLength", "inputLength"]) {
    if (Object.hasOwn(expected, field)) {
      checks.push(deepSubsetMatch(expected[field], actual?.[field], `$.structuredAppend.${field}`));
    }
  }

  if (Object.hasOwn(expected, "diagnosticsSubset")) {
    checks.push(deepSubsetMatch(expected.diagnosticsSubset, actual?.diagnostics, "$.structuredAppend.diagnostics"));
  }

  if (Object.hasOwn(expected, "symbolsSubset")) {
    checks.push(deepSubsetMatch(expected.symbolsSubset, actual?.symbols, "$.structuredAppend.symbols"));
  }

  if (Object.hasOwn(expected, "mergedSubset")) {
    checks.push(deepSubsetMatch(expected.mergedSubset, actual, "$.structuredAppend.merged"));
  }

  for (const result of checks) {
    if (!result.ok) {
      return result;
    }
  }

  if (checks.length > 0) {
    return { ok: true };
  }

  return {
    ok: false,
    path: "$.structuredAppend",
    expected,
    actual,
    reason: "unsupported structuredAppend expectation"
  };
}

function evaluateValidationExpectation(expected, execution) {
  const actual = execution.actual;

  if (execution.error) {
    if (expected.ok === false || expected.valid === false) {
      const actualError = errorDetails(execution.error);
      if (Array.isArray(expected.errors)) {
        for (const expectedError of expected.errors) {
          const result = deepSubsetMatch(expectedError, actualError, "$.validation.errors[thrown]");
          if (!result.ok) {
            return result;
          }
        }
      }
      return { ok: true };
    }

    return {
      ok: false,
      path: "$.validation",
      expected,
      actual: errorDetails(execution.error),
      reason: "operation threw while validation success was expected"
    };
  }

  if (!actual || typeof actual !== "object") {
    return {
      ok: false,
      path: "$.validation",
      expected,
      actual,
      reason: "actual validation result is not an object"
    };
  }

  const expectedOk = Object.hasOwn(expected, "ok") ? expected.ok : expected.valid;
  const actualOk = Object.hasOwn(actual, "ok") ? actual.ok : actual.valid;
  if (typeof expectedOk === "boolean" && actualOk !== expectedOk) {
    return {
      ok: false,
      path: "$.validation.ok",
      expected: expectedOk,
      actual: actualOk,
      reason: "validation status differs"
    };
  }

  if (Array.isArray(expected.errors)) {
    for (const expectedError of expected.errors) {
      const result = containsSubset(expectedError, actual.errors, "$.validation.errors");
      if (!result.ok) {
        return result;
      }
    }
  }

  if (Array.isArray(expected.warnings)) {
    for (const expectedWarning of expected.warnings) {
      const result = containsSubset(expectedWarning, actual.warnings, "$.validation.warnings");
      if (!result.ok) {
        return result;
      }
    }
  }

  const rest = Object.fromEntries(
    Object.entries(expected).filter(([key]) => !["ok", "valid", "errors", "warnings"].includes(key))
  );
  if (Object.keys(rest).length > 0) {
    return deepSubsetMatch(rest, actual, "$.validation");
  }

  return { ok: true };
}

export function evaluateExpectations(expect, execution) {
  const checks = [];

  if (Object.hasOwn(expect, "rejects")) {
    checks.push(checkResult("rejects", evaluateRejectsExpectation(expect.rejects, execution)));
  }

  if (execution.error && !Object.hasOwn(expect, "rejects")) {
    checks.push({
      name: "operation",
      status: "error",
      reason: "SpecQR operation threw unexpectedly",
      error: errorDetails(execution.error)
    });
    return checks;
  }

  if (Object.hasOwn(expect, "decode")) {
    checks.push(createSkippedCheck(
      "decode",
      "decode expectation は jsQR などの decoder lane で評価するため、SpecQR adapter では未評価です。"
    ));
  }

  if (Object.hasOwn(expect, "matrixHash")) {
    try {
      const actualHash = matrixHash(execution.actual?.matrix, expect.matrixHash);
      checks.push(checkResult("matrixHash", deepSubsetMatch(expect.matrixHash.value, actualHash, "$.matrixHash.value"), {
        algorithm: expect.matrixHash.algorithm ?? "sha256",
        encoding: expect.matrixHash.encoding ?? "row-major-bits"
      }));
    } catch (error) {
      checks.push({
        name: "matrixHash",
        status: "failed",
        reason: error.message
      });
    }
  }

  if (Object.hasOwn(expect, "diagnostics")) {
    const diagnostics = getActualDiagnostics(execution.actual);
    if (!diagnostics) {
      checks.push({
        name: "diagnostics.subset",
        status: "failed",
        reason: "SpecQR result did not include diagnostics"
      });
    } else if (Object.hasOwn(expect.diagnostics, "subset")) {
      checks.push(checkResult(
        "diagnostics.subset",
        deepSubsetMatch(expect.diagnostics.subset, diagnostics, "$.diagnostics")
      ));
    }
  }

  if (Object.hasOwn(expect, "planning")) {
    checks.push(checkResult("planning", evaluatePlanningExpectation(expect.planning, execution.actual)));
  }

  if (Object.hasOwn(expect, "gs1")) {
    checks.push(checkResult("gs1", evaluateGs1Expectation(expect.gs1, execution.actual)));
  }

  if (Object.hasOwn(expect, "structuredAppend")) {
    checks.push(checkResult(
      "structuredAppend",
      evaluateStructuredAppendExpectation(expect.structuredAppend, execution.actual)
    ));
  }

  if (Object.hasOwn(expect, "validation")) {
    checks.push(checkResult("validation", evaluateValidationExpectation(expect.validation, execution)));
  }

  return checks;
}

export function summarizeChecks(checks) {
  if (checks.some((check) => check.status === "error")) {
    return "error";
  }

  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  if (checks.some((check) => check.status === "passed")) {
    return "passed";
  }

  return "skipped";
}

function resultDetails(actual) {
  if (typeof actual === "string") {
    return {
      value: actual
    };
  }

  if (!actual || typeof actual !== "object") {
    return {};
  }

  const details = {};
  if (actual.diagnostics) {
    details.diagnostics = actual.diagnostics;
  }
  if (Object.hasOwn(actual, "ok") && (
    Object.hasOwn(actual, "selectedVersion") ||
    Object.hasOwn(actual, "dataBitLength") ||
    Object.hasOwn(actual, "capacityBits") ||
    actual.diagnostics?.phase === "planning"
  )) {
    details.planning = {
      ok: actual.ok,
      reason: actual.reason ?? null,
      selectedVersion: actual.selectedVersion ?? null,
      minVersion: actual.minVersion ?? null,
      maxVersion: actual.maxVersion ?? null,
      errorCorrectionLevel: actual.errorCorrectionLevel ?? null,
      mode: actual.mode ?? null,
      dataBitLength: actual.dataBitLength ?? null,
      capacityBits: actual.capacityBits ?? null,
      remainingBits: actual.remainingBits ?? null,
      overflowBits: actual.overflowBits ?? null,
      warnings: actual.warnings ?? []
    };
  } else if (
    Object.hasOwn(actual, "ok") &&
    (Object.hasOwn(actual, "elements") || Object.hasOwn(actual, "result") || Object.hasOwn(actual, "errors") || Object.hasOwn(actual, "warnings"))
  ) {
    details.gs1 = actual;
  } else if (Array.isArray(actual.symbols) && Object.hasOwn(actual, "total") && Object.hasOwn(actual, "parity")) {
    details.structuredAppend = {
      total: actual.total,
      parity: actual.parity,
      inputLength: actual.inputLength ?? null,
      byteLength: actual.byteLength ?? null,
      diagnostics: actual.diagnostics ?? null,
      symbols: actual.symbols.map((symbol, index) => ({
        index: index + 1,
        diagnostics: symbol && typeof symbol === "object" && !Array.isArray(symbol) ? symbol.diagnostics ?? null : null
      }))
    };
  } else if (Array.isArray(actual.parts) && Object.hasOwn(actual, "total") && Object.hasOwn(actual, "parity")) {
    details.structuredAppend = {
      data: actual.data instanceof Uint8Array ? { binaryHex: Array.from(actual.data, (byte) => byte.toString(16).padStart(2, "0")).join("") } : actual.data,
      total: actual.total,
      parity: actual.parity,
      parts: actual.parts,
      diagnostics: actual.diagnostics
    };
  }
  if (!Object.hasOwn(actual, "ok") && (Object.hasOwn(actual, "maxBytes") || Object.hasOwn(actual, "capacityBits"))) {
    details.capacity = actual;
  }
  return details;
}

export const adapter = {
  id: "specqr",
  name: "SpecQR",
  packageName: "specqr",
  packageVersion: "2.4.0",
  status: "active",
  supportsOperation,
  async run(vector) {
    if (!supportsOperation(vector.operation)) {
      return {
        vectorId: vector.id,
        adapterId: "specqr",
        status: "skipped",
        checks: [createSkippedCheck("operation", `SpecQR adapter does not support operation ${vector.operation}`)],
        reason: `Unsupported operation: ${vector.operation}`
      };
    }

    const execution = { actual: null, error: null };
    try {
      execution.actual = executeOperation(vector);
    } catch (error) {
      execution.error = error;
    }

    const checks = evaluateExpectations(vector.expect, execution);
    if (checks.length === 0) {
      checks.push(createSkippedCheck("expectation", "この vector には SpecQR adapter が評価できる expectation がありません。"));
    }

    const status = summarizeChecks(checks);
    const unexpectedError = checks.find((check) => check.status === "error");

    return {
      vectorId: vector.id,
      adapterId: "specqr",
      status,
      checks,
      ...(unexpectedError ? { reason: unexpectedError.reason, error: unexpectedError.error } : {}),
      ...(status === "failed" ? { reason: "one or more expectation checks failed" } : {}),
      details: resultDetails(execution.actual)
    };
  }
};

export default adapter;
