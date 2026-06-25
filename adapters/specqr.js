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
import { pngToRgba } from "../tools/png-rgba.js";

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

function hasRenderExpectation(vector) {
  return Object.hasOwn(vector.expect ?? {}, "render");
}

function isRenderRejectExpectation(vector) {
  return Object.hasOwn(vector.expect ?? {}, "rejects") &&
    ["png", "png-data-url"].includes(vector.options?.output);
}

function renderOutputFor(vector) {
  return vector.options.output ?? vector.expect?.render?.format ?? "matrix";
}

function operationOptions(vector, mode = "primary") {
  if (mode === "diagnostics") {
    return {
      ...vector.options,
      output: "matrix",
      diagnostics: true
    };
  }

  if (hasRenderExpectation(vector) || isRenderRejectExpectation(vector)) {
    return {
      ...vector.options,
      output: renderOutputFor(vector),
      diagnostics: false
    };
  }

  return {
    ...vector.options,
    output: vector.options.output ?? "matrix",
    diagnostics: vector.options.diagnostics ?? true
  };
}

function structuredAppendOptions(vector, mode = "primary") {
  if (mode === "diagnostics") {
    return {
      ...vector.options,
      output: "matrix",
      diagnostics: true
    };
  }

  if (hasRenderExpectation(vector) || isRenderRejectExpectation(vector)) {
    return {
      ...vector.options,
      output: renderOutputFor(vector),
      diagnostics: false
    };
  }

  return {
    ...vector.options,
    output: vector.options.output ?? "matrix",
    diagnostics: vector.options.diagnostics ?? true
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

function executeOperation(vector, mode = "primary") {
  switch (vector.operation) {
    case "generate":
      return generate(normalizeInput(vector.input), operationOptions(vector, mode));
    case "generateSegments":
      return generateSegments(normalizeSegments(vector.input.segments), operationOptions(vector, mode));
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
      return generateStructuredAppend(normalizeInput(vector.input), structuredAppendOptions(vector, mode));
    case "structuredAppend.generateSegments":
      return generateSegmentsStructuredAppend(normalizeSegments(vector.input.segments), structuredAppendOptions(vector, mode));
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

function createPassedCheck(name, details = {}) {
  return {
    name,
    status: "passed",
    ...details
  };
}

function matrixToRowMajorBitString(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0 || !Array.isArray(matrix[0])) {
    throw new Error("matrix must be a non-empty boolean[][]");
  }

  return matrix.map((row) => row.map((module) => (module ? "1" : "0")).join("")).join("\n");
}

function actualMatrix(actual) {
  if (Array.isArray(actual)) {
    return actual;
  }

  return actual?.matrix;
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

function getExecutionDiagnostics(execution) {
  return getActualDiagnostics(execution.diagnosticActual) ?? getActualDiagnostics(execution.actual);
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function renderFailure(path, expected, actual, reason) {
  return {
    ok: false,
    path,
    expected,
    actual,
    reason
  };
}

function isBooleanMatrix(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((row) => Array.isArray(row) && row.length > 0 && row.every((module) => typeof module === "boolean"));
}

function matrixShape(matrix) {
  if (!isBooleanMatrix(matrix)) {
    return null;
  }

  const rows = matrix.length;
  const columns = matrix[0].length;
  return {
    rows,
    columns,
    size: rows === columns ? rows : null,
    square: rows === columns
  };
}

function renderSummary(value) {
  if (value instanceof Uint8Array) {
    return {
      type: "Uint8Array",
      byteLength: value.length,
      prefix: Array.from(value.slice(0, 8))
    };
  }

  if (typeof value === "string") {
    return {
      type: "string",
      length: value.length,
      prefix: value.slice(0, 64)
    };
  }

  const shape = matrixShape(value);
  if (shape) {
    return {
      type: "matrix",
      ...shape
    };
  }

  if (value && typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value)
    };
  }

  return value;
}

function evaluateMatrixRender(expected = {}, actual, path = "$.render.matrix") {
  const shape = matrixShape(actual);
  if (!shape) {
    return renderFailure(path, "boolean[][]", renderSummary(actual), "render output is not a boolean matrix");
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!Object.hasOwn(shape, key)) {
      continue;
    }
    const result = deepSubsetMatch(expectedValue, shape[key], `${path}.${key}`);
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true, actual: shape };
}

function rootElement(svg) {
  const match = String(svg).trimStart().match(/^<([A-Za-z][A-Za-z0-9:._-]*)(\s[^>]*)?>/);
  if (!match) {
    return null;
  }

  const attrs = {};
  const source = match[2] ?? "";
  const attrPattern = /\s([A-Za-z_:][A-Za-z0-9:._-]*)="([^"]*)"/g;
  let attrMatch = attrPattern.exec(source);
  while (attrMatch) {
    attrs[attrMatch[1]] = attrMatch[2];
    attrMatch = attrPattern.exec(source);
  }

  return {
    name: match[1],
    attrs
  };
}

function compareSvgAttribute(root, name, expectedValue, path) {
  const actualValue = root?.attrs?.[name];
  if (String(actualValue) !== String(expectedValue)) {
    return renderFailure(path, String(expectedValue), actualValue, `${name} differs`);
  }
  return { ok: true };
}

function evaluateSvgRender(expected = {}, svg, path = "$.render.svg") {
  if (typeof svg !== "string") {
    return renderFailure(path, "SVG string", renderSummary(svg), "render output is not a string");
  }

  if (Object.hasOwn(expected, "prefix") && !svg.trimStart().startsWith(expected.prefix)) {
    return renderFailure(`${path}.prefix`, expected.prefix, svg.slice(0, expected.prefix.length), "SVG prefix differs");
  }

  const root = rootElement(svg);
  if (Object.hasOwn(expected, "rootElement")) {
    const result = deepSubsetMatch(expected.rootElement, root?.name, `${path}.rootElement`);
    if (!result.ok) {
      return result;
    }
  }

  for (const name of ["width", "height", "viewBox"]) {
    if (Object.hasOwn(expected, name)) {
      const result = compareSvgAttribute(root, name, expected[name], `${path}.${name}`);
      if (!result.ok) {
        return result;
      }
    }
  }

  if (Array.isArray(expected.contains)) {
    for (const [index, text] of expected.contains.entries()) {
      if (!svg.includes(text)) {
        return renderFailure(`${path}.contains[${index}]`, text, null, "SVG does not include expected text");
      }
    }
  }

  return {
    ok: true,
    actual: {
      rootElement: root?.name ?? null,
      width: root?.attrs?.width ?? null,
      height: root?.attrs?.height ?? null,
      viewBox: root?.attrs?.viewBox ?? null,
      length: svg.length
    }
  };
}

function hasPngSignature(bytes) {
  return bytes instanceof Uint8Array && pngSignature.every((byte, index) => bytes[index] === byte);
}

function evaluatePngRender(expected = {}, bytes, path = "$.render.png") {
  if (!(bytes instanceof Uint8Array)) {
    return renderFailure(path, "PNG Uint8Array", renderSummary(bytes), "render output is not a Uint8Array");
  }

  if (expected.signature !== false && !hasPngSignature(bytes)) {
    return renderFailure(`${path}.signature`, pngSignature, Array.from(bytes.slice(0, 8)), "PNG signature differs");
  }

  let image = null;
  if (Object.hasOwn(expected, "width") || Object.hasOwn(expected, "height") || Object.hasOwn(expected, "hasTransparentPixels")) {
    try {
      image = pngToRgba(bytes);
    } catch (error) {
      return renderFailure(path, "parseable PNG", error.message, "PNG reader failed");
    }
  }

  if (Object.hasOwn(expected, "width")) {
    const result = deepSubsetMatch(expected.width, image.width, `${path}.width`);
    if (!result.ok) {
      return result;
    }
  }

  if (Object.hasOwn(expected, "height")) {
    const result = deepSubsetMatch(expected.height, image.height, `${path}.height`);
    if (!result.ok) {
      return result;
    }
  }

  if (Object.hasOwn(expected, "hasTransparentPixels")) {
    const hasTransparentPixels = Array.from({ length: image.width * image.height }).some((_, index) => {
      return image.rgba[index * 4 + 3] < 255;
    });
    const result = deepSubsetMatch(expected.hasTransparentPixels, hasTransparentPixels, `${path}.hasTransparentPixels`);
    if (!result.ok) {
      return result;
    }
  }

  return {
    ok: true,
    actual: {
      byteLength: bytes.length,
      signature: true,
      width: image?.width ?? null,
      height: image?.height ?? null
    }
  };
}

function parseDataUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^data:([^,]*),(.*)$/s);
  if (!match) {
    return null;
  }

  const header = match[1];
  const parts = header.split(";");
  return {
    header,
    mediaType: parts[0] || "text/plain",
    base64: parts.includes("base64"),
    data: match[2]
  };
}

function dataUrlBytes(info) {
  return info.base64
    ? new Uint8Array(Buffer.from(info.data, "base64"))
    : new TextEncoder().encode(decodeURIComponent(info.data));
}

function dataUrlText(info) {
  return info.base64
    ? Buffer.from(info.data, "base64").toString("utf8")
    : decodeURIComponent(info.data);
}

function evaluateDataUrlRender(expected = {}, actual, path = "$.render.dataUrl") {
  if (typeof actual !== "string") {
    return renderFailure(path, "Data URL string", renderSummary(actual), "render output is not a string");
  }

  if (Object.hasOwn(expected, "prefix") && !actual.startsWith(expected.prefix)) {
    return renderFailure(`${path}.prefix`, expected.prefix, actual.slice(0, expected.prefix.length), "Data URL prefix differs");
  }

  const info = parseDataUrl(actual);
  if (!info) {
    return renderFailure(path, "valid Data URL", actual.slice(0, 64), "render output is not a Data URL");
  }

  if (Object.hasOwn(expected, "mediaType")) {
    const result = deepSubsetMatch(expected.mediaType, info.mediaType, `${path}.mediaType`);
    if (!result.ok) {
      return result;
    }
  }

  return {
    ok: true,
    actual: {
      mediaType: info.mediaType,
      base64: info.base64,
      length: actual.length
    },
    info
  };
}

function renderDetails(actual) {
  const shape = matrixShape(actual);
  if (shape) {
    return {
      format: "matrix",
      ...shape
    };
  }

  if (actual instanceof Uint8Array) {
    const details = {
      format: "png",
      byteLength: actual.length,
      pngSignature: hasPngSignature(actual)
    };
    try {
      const image = pngToRgba(actual);
      details.width = image.width;
      details.height = image.height;
    } catch {
      details.width = null;
      details.height = null;
    }
    return details;
  }

  if (typeof actual === "string") {
    const dataUrl = parseDataUrl(actual);
    if (dataUrl) {
      return {
        format: dataUrl.mediaType === "image/png" ? "png-data-url" : "svg-data-url",
        mediaType: dataUrl.mediaType,
        base64: dataUrl.base64,
        length: actual.length
      };
    }

    if (!actual.trimStart().startsWith("<svg")) {
      return null;
    }

    const root = rootElement(actual);
    return {
      format: "svg",
      length: actual.length,
      rootElement: root?.name ?? null,
      width: root?.attrs?.width ?? null,
      height: root?.attrs?.height ?? null,
      viewBox: root?.attrs?.viewBox ?? null
    };
  }

  return null;
}

function evaluateRenderExpectation(expected, execution) {
  const checks = [];
  const actual = execution.actual;

  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return [checkResult("render", renderFailure("$.render", "object", expected, "render expectation must be an object"))];
  }

  const format = expected.format;
  if (!["matrix", "svg", "png", "svg-data-url", "png-data-url"].includes(format)) {
    return [checkResult("render.format", renderFailure("$.render.format", "known render format", format, "unsupported render expectation format"))];
  }

  const actualSummary = renderSummary(actual);
  let formatOk = false;
  if (format === "matrix") {
    formatOk = Boolean(matrixShape(actual));
  } else if (format === "svg") {
    formatOk = typeof actual === "string" && !parseDataUrl(actual);
  } else if (format === "png") {
    formatOk = actual instanceof Uint8Array;
  } else if (format === "svg-data-url" || format === "png-data-url") {
    const info = parseDataUrl(actual);
    formatOk = Boolean(info) && (
      (format === "svg-data-url" && info.mediaType === "image/svg+xml") ||
      (format === "png-data-url" && info.mediaType === "image/png")
    );
  }

  checks.push(checkResult(
    "render.format",
    formatOk
      ? { ok: true }
      : renderFailure("$.render.format", format, actualSummary, "render output format differs"),
    { format }
  ));

  if (!formatOk) {
    return checks;
  }

  if (format === "matrix") {
    checks.push(checkResult("render.matrix", evaluateMatrixRender(expected.matrix ?? {}, actual)));
  }

  if (format === "svg") {
    checks.push(checkResult("render.svg", evaluateSvgRender(expected.svg ?? {}, actual)));
  }

  if (format === "png") {
    checks.push(checkResult("render.png", evaluatePngRender(expected.png ?? {}, actual)));
  }

  if (format === "svg-data-url" || format === "png-data-url") {
    const dataUrlResult = evaluateDataUrlRender(expected.dataUrl ?? {}, actual);
    checks.push(checkResult("render.dataUrl", dataUrlResult));
    if (dataUrlResult.ok && format === "svg-data-url") {
      checks.push(checkResult("render.svg", evaluateSvgRender(expected.svg ?? {}, dataUrlText(dataUrlResult.info))));
    }
    if (dataUrlResult.ok && format === "png-data-url") {
      checks.push(checkResult("render.png", evaluatePngRender(expected.png ?? {}, dataUrlBytes(dataUrlResult.info))));
    }
  }

  if (Object.hasOwn(expected, "diagnosticsSubset")) {
    const diagnostics = getExecutionDiagnostics(execution);
    checks.push(checkResult(
      "render.diagnosticsSubset",
      diagnostics
        ? deepSubsetMatch(expected.diagnosticsSubset, diagnostics, "$.render.diagnostics")
        : renderFailure("$.render.diagnostics", expected.diagnosticsSubset, null, "additional diagnostics were not available")
    ));
  }

  return checks;
}

function needsAdditionalDiagnostics(vector) {
  if (!hasRenderExpectation(vector)) {
    return false;
  }

  return Object.hasOwn(vector.expect, "diagnostics") || Object.hasOwn(vector.expect.render ?? {}, "diagnosticsSubset");
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

  if (execution.diagnosticsGenerated) {
    if (execution.diagnosticError) {
      checks.push({
        name: "diagnostics.generation",
        status: "error",
        reason: "render vector の diagnostics subset 評価用 generation が失敗しました。",
        error: errorDetails(execution.diagnosticError)
      });
    } else {
      checks.push(createPassedCheck("diagnostics.generation", {
        mode: "additional",
        reason: "render output を変えないため、diagnostics subset は追加の matrix generation で評価しました。"
      }));
    }
  }

  if (Object.hasOwn(expect, "render")) {
    checks.push(...evaluateRenderExpectation(expect.render, execution));
  }

  if (Object.hasOwn(expect, "matrixHash")) {
    try {
      const actualHash = matrixHash(actualMatrix(execution.actual), expect.matrixHash);
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
    const diagnostics = getExecutionDiagnostics(execution);
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

function resultDetails(actual, execution = {}) {
  const render = renderDetails(actual);
  if (render) {
    const details = {
      render
    };
    if (execution.diagnosticsGenerated) {
      details.diagnosticsGeneration = {
        mode: "additional",
        ok: !execution.diagnosticError
      };
    }
    return details;
  }

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

    const execution = {
      actual: null,
      error: null,
      diagnosticActual: null,
      diagnosticError: null,
      diagnosticsGenerated: false
    };
    try {
      execution.actual = executeOperation(vector);
    } catch (error) {
      execution.error = error;
    }

    if (!execution.error && needsAdditionalDiagnostics(vector)) {
      execution.diagnosticsGenerated = true;
      try {
        execution.diagnosticActual = executeOperation(vector, "diagnostics");
      } catch (error) {
        execution.diagnosticError = error;
      }
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
      details: resultDetails(execution.actual, execution)
    };
  }
};

export default adapter;
