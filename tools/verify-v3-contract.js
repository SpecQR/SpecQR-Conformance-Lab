import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { deepEqual, sha256, stableStringify, statusCounts, writeJson } from "./rc-utils.js";
import { runV3TypescriptConsumers } from "./rc-typescript.js";

const entryKeys = [
  "sourceSegmentIndex",
  "mode",
  "unitStart",
  "unitLength",
  "byteStart",
  "byteLength"
];

function selectImportTarget(exportsEntry) {
  if (typeof exportsEntry === "string") {
    return exportsEntry;
  }
  const target = exportsEntry?.import ?? exportsEntry?.default;
  if (typeof target !== "string") {
    throw new Error("Published root export has no import target");
  }
  return target;
}

async function importRoot(packageRoot, packageJson) {
  const relativePath = selectImportTarget(packageJson.exports?.["."]);
  const absolutePath = path.resolve(packageRoot, relativePath);
  if (!absolutePath.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error("Published root export escapes the package root");
  }
  return import(`${pathToFileURL(absolutePath).href}?v3-contract=${Date.now()}-${Math.random()}`);
}

function matrixHash(matrix) {
  const rows = matrix.map((row) => row.map((module) => module ? "1" : "0").join("")).join("\n");
  return sha256(rows);
}

function symbolMatrix(symbol) {
  return Array.isArray(symbol) ? symbol : symbol?.matrix;
}

function symbolHashes(result) {
  return result.symbols.map((symbol) => matrixHash(symbolMatrix(symbol)));
}

function expectedSplitUnits(segments) {
  const encoder = new TextEncoder();
  const units = [];
  let byteStart = 0;
  for (const [sourceSegmentIndex, segment] of segments.entries()) {
    const characters = Array.from(segment.data);
    if (segment.mode !== "byte") {
      const byteLength = encoder.encode(segment.data).length;
      units.push({
        sourceSegmentIndex,
        mode: segment.mode,
        unitStart: 0,
        unitLength: characters.length,
        byteStart,
        byteLength
      });
      byteStart += byteLength;
      continue;
    }

    for (const [unitStart, character] of characters.entries()) {
      const byteLength = encoder.encode(character).length;
      units.push({
        sourceSegmentIndex,
        mode: segment.mode,
        unitStart,
        unitLength: 1,
        byteStart,
        byteLength
      });
      byteStart += byteLength;
    }
  }
  return units;
}

function createRecorder() {
  const checks = [];
  function check(id, condition, details = {}) {
    checks.push({ id, status: condition ? "passed" : "failed", ...details });
  }
  function attempt(id, callback) {
    try {
      const result = callback();
      check(id, result === undefined ? true : Boolean(result));
    } catch (error) {
      checks.push({ id, status: "failed", error: { name: error.name, message: error.message } });
    }
  }
  return { checks, check, attempt };
}

function rejection(callback) {
  try {
    callback();
    return null;
  } catch (error) {
    return { name: error.name, code: error.code ?? null, message: error.message };
  }
}

function comparableContract(evidence) {
  return {
    resolvedVersion: evidence.target.resolvedVersion,
    input: evidence.input,
    observations: evidence.observations,
    checks: evidence.checks,
    summary: evidence.summary,
    requiredCheckCount: evidence.requiredCheckCount,
    status: evidence.status
  };
}

export function compareV3ContractEvidence(exact, next) {
  const exactComparable = comparableContract(exact);
  const nextComparable = comparableContract(next);
  const identical = deepEqual(exactComparable, nextComparable);
  return {
    schemaVersion: 1,
    kind: "specqr-v3-contract-selector-comparison",
    exact: exact.target,
    next: next.target,
    exactFingerprint: sha256(stableStringify(exactComparable)),
    nextFingerprint: sha256(stableStringify(nextComparable)),
    identical,
    status: exact.status === "pass" && next.status === "pass" && identical ? "pass" : "blocked"
  };
}

export async function verifyV3Contract(options) {
  const cwd = options.cwd ?? process.cwd();
  const packageRoot = path.resolve(options.packageRoot);
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const specqr = await importRoot(packageRoot, packageJson);
  const segments = [
    { mode: "numeric", data: "1234567890" },
    { mode: "alphanumeric", data: "HELLO123" },
    { mode: "byte", data: "é😀Z".repeat(20) }
  ];
  const expectedUnits = expectedSplitUnits(segments);
  const commonOptions = {
    version: 2,
    errorCorrectionLevel: "L",
    output: "matrix",
    maxSymbols: 16
  };
  const standard = specqr.generateSegmentsStructuredAppend(segments, {
    ...commonOptions,
    diagnostics: true
  });
  const standardObject = specqr.generateSegmentsStructuredAppend(segments, {
    ...commonOptions,
    diagnostics: { splitUnits: "summary", symbolResults: "diagnostics" }
  });
  const full = specqr.generateSegmentsStructuredAppend(segments, {
    ...commonOptions,
    diagnostics: { splitUnits: "full" }
  });
  const fullOutput = specqr.generateSegmentsStructuredAppend(segments, {
    ...commonOptions,
    diagnostics: { splitUnits: "full", symbolResults: "output" }
  });
  const summaryOutput = specqr.generateSegmentsStructuredAppend(segments, {
    ...commonOptions,
    diagnostics: { splitUnits: "summary", symbolResults: "output" }
  });
  const staticFull = specqr.QRCode.generateSegmentsStructuredAppend(segments, {
    ...commonOptions,
    diagnostics: { splitUnits: "full" }
  });
  const recorder = createRecorder();
  const { check, attempt, checks } = recorder;

  check("standard-detail-summary", standard.diagnostics.splitUnitsDetail === "summary");
  check("standard-count-exact", standard.diagnostics.splitUnitCount === expectedUnits.length, {
    expected: expectedUnits.length,
    actual: standard.diagnostics.splitUnitCount
  });
  check("standard-no-own-split-units", !Object.hasOwn(standard.diagnostics, "splitUnits"));
  check("standard-no-split-units-descriptor", Object.getOwnPropertyDescriptor(standard.diagnostics, "splitUnits") === undefined);
  const standardJson = JSON.stringify(standard.diagnostics);
  check("standard-json-omits-split-units", !Object.hasOwn(JSON.parse(standardJson), "splitUnits"));
  check("standard-object-selection", standardObject.diagnostics.splitUnitsDetail === "summary" && !Object.hasOwn(standardObject.diagnostics, "splitUnits"));

  check("full-detail-full", full.diagnostics.splitUnitsDetail === "full");
  check("full-own-split-units", Object.hasOwn(full.diagnostics, "splitUnits"));
  check("full-array", Array.isArray(full.diagnostics.splitUnits));
  check("full-count-exact", full.diagnostics.splitUnitCount === expectedUnits.length && full.diagnostics.splitUnits.length === expectedUnits.length, {
    expected: expectedUnits.length,
    count: full.diagnostics.splitUnitCount,
    length: full.diagnostics.splitUnits.length
  });
  check("full-order-and-offsets", deepEqual(full.diagnostics.splitUnits, expectedUnits), {
    expectedFingerprint: sha256(stableStringify(expectedUnits)),
    actualFingerprint: sha256(stableStringify(full.diagnostics.splitUnits))
  });
  check("full-entry-property-order", full.diagnostics.splitUnits.every((unit) => deepEqual(Object.keys(unit), entryKeys)));
  check("full-byte-offset-continuity", full.diagnostics.splitUnits.every((unit, index, units) => {
    return index === 0 || unit.byteStart === units[index - 1].byteStart + units[index - 1].byteLength;
  }));
  check("full-plain-data", Object.getPrototypeOf(full.diagnostics.splitUnits) === Array.prototype && full.diagnostics.splitUnits.every((unit) => Object.getPrototypeOf(unit) === Object.prototype));
  check("full-array-not-frozen", !Object.isFrozen(full.diagnostics.splitUnits) && full.diagnostics.splitUnits.every((unit) => !Object.isFrozen(unit)));
  attempt("full-array-mutable", () => {
    const originalLength = full.diagnostics.splitUnits.length;
    full.diagnostics.splitUnits.push({ ...full.diagnostics.splitUnits.at(-1) });
    const pushed = full.diagnostics.splitUnits.length === originalLength + 1;
    full.diagnostics.splitUnits.pop();
    return pushed && full.diagnostics.splitUnits.length === originalLength;
  });
  attempt("full-entry-mutable", () => {
    const original = full.diagnostics.splitUnits[0].byteStart;
    full.diagnostics.splitUnits[0].byteStart = original + 1;
    const changed = full.diagnostics.splitUnits[0].byteStart === original + 1;
    full.diagnostics.splitUnits[0].byteStart = original;
    return changed;
  });
  const fullJson = JSON.stringify(full.diagnostics);
  check("full-json-includes-array", Array.isArray(JSON.parse(fullJson).splitUnits));
  check("full-json-round-trip", deepEqual(JSON.parse(fullJson), full.diagnostics));
  attempt("full-structured-clone", () => {
    const cloned = structuredClone(full.diagnostics);
    return deepEqual(cloned, full.diagnostics) && cloned.splitUnits !== full.diagnostics.splitUnits;
  });
  const freshFull = specqr.generateSegmentsStructuredAppend(segments, {
    ...commonOptions,
    diagnostics: { splitUnits: "full" }
  });
  check("full-fresh-call-isolation", freshFull.diagnostics.splitUnits !== full.diagnostics.splitUnits && deepEqual(freshFull.diagnostics.splitUnits, full.diagnostics.splitUnits));

  check("symbol-results-output-summary", summaryOutput.symbols.every((symbol) => Array.isArray(symbol) && typeof symbol[0]?.[0] === "boolean"));
  check("symbol-results-output-full", fullOutput.symbols.every((symbol) => Array.isArray(symbol) && typeof symbol[0]?.[0] === "boolean"));
  check("symbol-results-diagnostics", standardObject.symbols.every((symbol) => {
    return !Array.isArray(symbol) && Array.isArray(symbol.matrix) && typeof symbol.svg === "string" && typeof symbol.diagnostics === "object";
  }));
  check("symbol-mode-matrix-equivalence", deepEqual(symbolHashes(summaryOutput), symbolHashes(standardObject)) && deepEqual(symbolHashes(fullOutput), symbolHashes(full)));
  check("detail-selection-matrix-equivalence", deepEqual(symbolHashes(summaryOutput), symbolHashes(fullOutput)));
  check("detail-selection-summary-equivalence", standardObject.total === full.total && standardObject.parity === full.parity && standardObject.byteLength === full.byteLength);

  check("named-static-export-present", typeof specqr.generateSegmentsStructuredAppend === "function" && typeof specqr.QRCode?.generateSegmentsStructuredAppend === "function");
  check("named-static-total-parity", full.total === staticFull.total && full.parity === staticFull.parity);
  check("named-static-full-array", deepEqual(full.diagnostics.splitUnits, staticFull.diagnostics.splitUnits));
  check("named-static-matrices", deepEqual(symbolHashes(full), symbolHashes(staticFull)));

  const rawNamed = rejection(() => specqr.generateStructuredAppend("RAW STRUCTURED APPEND", {
    ...commonOptions,
    diagnostics: { splitUnits: "full" }
  }));
  const rawStatic = rejection(() => specqr.QRCode.generateStructuredAppend("RAW STRUCTURED APPEND", {
    ...commonOptions,
    diagnostics: { splitUnits: "full" }
  }));
  check("raw-named-rejects-manual-object", rawNamed?.code === "INVALID_INPUT", { actual: rawNamed });
  check("raw-static-rejects-manual-object", rawStatic?.code === "INVALID_INPUT", { actual: rawStatic });

  const typescriptChecks = await runV3TypescriptConsumers(packageRoot, { cwd });
  checks.push(...typescriptChecks);
  const summary = statusCounts(checks);
  const observations = {
    splitUnitsSha256: sha256(stableStringify(full.diagnostics.splitUnits)),
    standardDiagnosticsSha256: sha256(stableStringify(standardObject.diagnostics)),
    fullDiagnosticsSha256: sha256(stableStringify(full.diagnostics)),
    standardSymbolMatricesSha256: sha256(stableStringify(symbolHashes(standardObject))),
    fullSymbolMatricesSha256: sha256(stableStringify(symbolHashes(full))),
    outputSymbolMatricesSha256: sha256(stableStringify(symbolHashes(fullOutput))),
    rawNamedRejection: rawNamed,
    rawStaticRejection: rawStatic
  };
  const evidence = {
    schemaVersion: 1,
    kind: "specqr-v3-candidate-contract",
    target: {
      requested: options.requested,
      resolvedVersion: packageJson.version,
      source: "npm-registry"
    },
    input: {
      segmentCount: segments.length,
      expectedSplitUnitCount: expectedUnits.length,
      expectedByteLength: expectedUnits.reduce((total, unit) => total + unit.byteLength, 0),
      version: commonOptions.version,
      errorCorrectionLevel: commonOptions.errorCorrectionLevel
    },
    observations,
    checks,
    requiredCheckCount: checks.length,
    summary,
    status: summary.failed === 0 ? "pass" : "blocked"
  };
  if (options.outputPath) {
    await writeJson(options.outputPath, evidence);
  }
  return evidence;
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ["--package-root", "packageRoot"],
    ["--requested", "requested"],
    ["--output", "outputPath"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) {
      throw new Error(`Invalid v3 contract argument: ${argv[index]}`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  if (!options.packageRoot || !options.requested) {
    throw new Error("v3 contract verifier requires --package-root and --requested");
  }
  return options;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await verifyV3Contract(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
