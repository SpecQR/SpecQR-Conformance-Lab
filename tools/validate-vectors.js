import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const vectorsDir = path.resolve("vectors");
const allowedOperations = new Set([
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

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...details }, null, 2));
  process.exitCode = 1;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label}: must be an object`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: must be a non-empty string`);
  }
}

function assertRequiredFields(value, fields, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`${label}: missing required field ${field}`);
    }
  }
}

function validateBinaryHex(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label}: binaryHex must be a string`);
  }

  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label}: binaryHex must be an even-length hex string`);
  }
}

function validateBinaryHexFields(value, label) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateBinaryHexFields(item, `${label}[${index}]`);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childLabel = `${label}.${key}`;
    if (key === "binaryHex") {
      validateBinaryHex(child, childLabel);
    } else {
      validateBinaryHexFields(child, childLabel);
    }
  }
}

function validateTags(vector, label) {
  if (!Object.hasOwn(vector, "tags")) {
    return;
  }

  if (!Array.isArray(vector.tags)) {
    throw new Error(`${label}: tags must be an array of strings`);
  }

  for (const [index, tag] of vector.tags.entries()) {
    if (typeof tag !== "string" || tag.length === 0) {
      throw new Error(`${label}: tags[${index}] must be a non-empty string`);
    }
  }
}

function validateNotes(vector, label) {
  if (Object.hasOwn(vector, "notes") && typeof vector.notes !== "string") {
    throw new Error(`${label}: notes must be a string when present`);
  }
}

function hasNegativeMarker(vector) {
  const category = String(vector.category ?? "").toLowerCase();
  const tags = Array.isArray(vector.tags) ? vector.tags.map((tag) => tag.toLowerCase()) : [];
  return category.includes("negative") || category.includes("reject") || tags.includes("negative") || tags.includes("reject");
}

function validateExpectation(expect, label) {
  if (Object.hasOwn(expect, "decode")) {
    assertObject(expect.decode, `${label}.expect.decode`);
    validateBinaryHexFields(expect.decode, `${label}.expect.decode`);
  }

  if (Object.hasOwn(expect, "matrixHash")) {
    assertObject(expect.matrixHash, `${label}.expect.matrixHash`);
    assertString(expect.matrixHash.algorithm, `${label}.expect.matrixHash.algorithm`);
    assertString(expect.matrixHash.value, `${label}.expect.matrixHash.value`);

    if (expect.matrixHash.algorithm === "sha256" && !/^[0-9a-fA-F]{64}$/.test(expect.matrixHash.value)) {
      throw new Error(`${label}.expect.matrixHash.value: sha256 hash must be 64 hex characters`);
    }
  }

  if (Object.hasOwn(expect, "referenceMatrix")) {
    assertObject(expect.referenceMatrix, `${label}.expect.referenceMatrix`);
    if (expect.referenceMatrix.adapter !== "nayuki") {
      throw new Error(`${label}.expect.referenceMatrix.adapter: must be "nayuki"`);
    }
    if (expect.referenceMatrix.exact !== true) {
      throw new Error(`${label}.expect.referenceMatrix.exact: must be true`);
    }
    if (expect.referenceMatrix.scope !== "fixed-version-ecc-mask") {
      throw new Error(`${label}.expect.referenceMatrix.scope: must be "fixed-version-ecc-mask"`);
    }
  }

  if (Object.hasOwn(expect, "diagnostics")) {
    assertObject(expect.diagnostics, `${label}.expect.diagnostics`);
    if (Object.hasOwn(expect.diagnostics, "subset")) {
      assertObject(expect.diagnostics.subset, `${label}.expect.diagnostics.subset`);
    }
  }

  if (Object.hasOwn(expect, "planning")) {
    assertObject(expect.planning, `${label}.expect.planning`);
  }

  if (Object.hasOwn(expect, "gs1")) {
    assertObject(expect.gs1, `${label}.expect.gs1`);
    if (Object.hasOwn(expect.gs1, "elementString")) {
      assertString(expect.gs1.elementString, `${label}.expect.gs1.elementString`);
    }
    if (Object.hasOwn(expect.gs1, "digitalLink")) {
      assertString(expect.gs1.digitalLink, `${label}.expect.gs1.digitalLink`);
    }
    if (Object.hasOwn(expect.gs1, "normalized")) {
      assertString(expect.gs1.normalized, `${label}.expect.gs1.normalized`);
    }
    if (Object.hasOwn(expect.gs1, "validationSubset")) {
      assertObject(expect.gs1.validationSubset, `${label}.expect.gs1.validationSubset`);
    }
  }

  if (Object.hasOwn(expect, "structuredAppend")) {
    assertObject(expect.structuredAppend, `${label}.expect.structuredAppend`);
    for (const key of ["total", "parity", "byteLength", "inputLength"]) {
      if (Object.hasOwn(expect.structuredAppend, key) && !Number.isInteger(expect.structuredAppend[key])) {
        throw new Error(`${label}.expect.structuredAppend.${key}: must be an integer when present`);
      }
    }
    if (Object.hasOwn(expect.structuredAppend, "diagnosticsSubset")) {
      assertObject(expect.structuredAppend.diagnosticsSubset, `${label}.expect.structuredAppend.diagnosticsSubset`);
    }
    if (Object.hasOwn(expect.structuredAppend, "symbolsSubset") && !Array.isArray(expect.structuredAppend.symbolsSubset)) {
      throw new Error(`${label}.expect.structuredAppend.symbolsSubset: must be an array when present`);
    }
    if (Object.hasOwn(expect.structuredAppend, "mergedSubset")) {
      assertObject(expect.structuredAppend.mergedSubset, `${label}.expect.structuredAppend.mergedSubset`);
    }
  }

  if (Object.hasOwn(expect, "validation")) {
    assertObject(expect.validation, `${label}.expect.validation`);
    const hasValid = Object.hasOwn(expect.validation, "valid");
    const hasOk = Object.hasOwn(expect.validation, "ok");
    if (!hasValid && !hasOk) {
      throw new Error(`${label}.expect.validation: must define valid or ok boolean`);
    }
    if (hasValid && typeof expect.validation.valid !== "boolean") {
      throw new Error(`${label}.expect.validation.valid: must be a boolean`);
    }
    if (hasOk && typeof expect.validation.ok !== "boolean") {
      throw new Error(`${label}.expect.validation.ok: must be a boolean`);
    }
    if (Object.hasOwn(expect.validation, "errors") && !Array.isArray(expect.validation.errors)) {
      throw new Error(`${label}.expect.validation.errors: must be an array when present`);
    }
    if (Object.hasOwn(expect.validation, "warnings") && !Array.isArray(expect.validation.warnings)) {
      throw new Error(`${label}.expect.validation.warnings: must be an array when present`);
    }
  }

  if (Object.hasOwn(expect, "rejects")) {
    assertObject(expect.rejects, `${label}.expect.rejects`);
  }
}

function validateReferenceMatrix(vector, label) {
  if (!Object.hasOwn(vector.expect, "referenceMatrix")) {
    return;
  }

  if (vector.operation !== "generate" && vector.operation !== "generateSegments") {
    throw new Error(`${label}.expect.referenceMatrix: operation must be generate or generateSegments`);
  }

  if (!Number.isInteger(vector.options.version) || vector.options.version < 1 || vector.options.version > 40) {
    throw new Error(`${label}.options.version: referenceMatrix requires fixed integer version 1..40`);
  }

  if (!["L", "M", "Q", "H"].includes(vector.options.errorCorrectionLevel)) {
    throw new Error(`${label}.options.errorCorrectionLevel: referenceMatrix requires fixed ECC L/M/Q/H`);
  }

  if (!Number.isInteger(vector.options.maskPattern) || vector.options.maskPattern < 0 || vector.options.maskPattern > 7) {
    throw new Error(`${label}.options.maskPattern: referenceMatrix requires fixed maskPattern 0..7`);
  }
}

function validateOperationInput(vector, label) {
  if (
    (vector.operation === "generateSegments" ||
      vector.operation === "analyzeSegments" ||
      vector.operation === "structuredAppend.generateSegments") &&
    !Array.isArray(vector.input.segments)
  ) {
    throw new Error(`${label}.input.segments: must be an array for ${vector.operation}`);
  }

  if (vector.operation === "structuredAppend.mergeParts" && !Array.isArray(vector.input.parts)) {
    throw new Error(`${label}.input.parts: must be an array for ${vector.operation}`);
  }

  if (vector.operation === "getCapacity") {
    if (!Object.hasOwn(vector.input, "version")) {
      throw new Error(`${label}.input.version: required for getCapacity`);
    }
    if (!Object.hasOwn(vector.input, "errorCorrectionLevel")) {
      throw new Error(`${label}.input.errorCorrectionLevel: required for getCapacity`);
    }
  }
}

function validateVector(file, vector, index, seenVectorIds) {
  const provisionalLabel = `${file}: vector ${index}`;
  assertObject(vector, provisionalLabel);
  assertRequiredFields(vector, ["id", "title", "category", "operation", "input", "options", "expect"], provisionalLabel);
  assertString(vector.id, `${provisionalLabel}.id`);

  const label = `${file}: vector ${vector.id}`;
  assertString(vector.title, `${label}.title`);
  assertString(vector.category, `${label}.category`);
  assertString(vector.operation, `${label}.operation`);

  if (seenVectorIds.has(vector.id)) {
    throw new Error(`${label}: duplicate vector id; first seen in ${seenVectorIds.get(vector.id)}`);
  }
  seenVectorIds.set(vector.id, file);

  if (!allowedOperations.has(vector.operation)) {
    throw new Error(`${label}.operation: unsupported operation ${vector.operation}`);
  }

  assertObject(vector.input, `${label}.input`);
  assertObject(vector.options, `${label}.options`);
  assertObject(vector.expect, `${label}.expect`);
  validateTags(vector, label);
  validateNotes(vector, label);
  validateBinaryHexFields(vector.input, `${label}.input`);
  validateBinaryHexFields(vector.options, `${label}.options`);
  validateBinaryHexFields(vector.expect, `${label}.expect`);
  validateExpectation(vector.expect, label);
  validateOperationInput(vector, label);
  validateReferenceMatrix(vector, label);

  if (hasNegativeMarker(vector) && !Object.hasOwn(vector.expect, "rejects") && !Object.hasOwn(vector.expect, "validation")) {
    throw new Error(`${label}: negative/reject vectors must define expect.rejects or expect.validation`);
  }

  return {
    id: vector.id,
    category: vector.category,
    operation: vector.operation
  };
}

function validateSuite(file, suite, seenVectorIds, seenSuiteIds) {
  assertObject(suite, file);
  assertRequiredFields(suite, ["version", "id", "name", "description", "category", "vectors"], file);

  if (suite.version !== 1) {
    throw new Error(`${file}: version must be 1`);
  }

  assertString(suite.id, `${file}.id`);
  assertString(suite.name, `${file}.name`);
  assertString(suite.description, `${file}.description`);
  assertString(suite.category, `${file}.category`);

  if (seenSuiteIds.has(suite.id)) {
    throw new Error(`${file}: duplicate suite id ${suite.id}; first seen in ${seenSuiteIds.get(suite.id)}`);
  }
  seenSuiteIds.set(suite.id, file);

  if (!Array.isArray(suite.vectors)) {
    throw new Error(`${file}.vectors: must be an array`);
  }

  const vectors = suite.vectors.map((vector, index) => validateVector(file, vector, index, seenVectorIds));

  return {
    file,
    id: suite.id,
    name: suite.name,
    category: suite.category,
    vectorCount: vectors.length,
    vectors
  };
}

try {
  const entries = await readdir(vectorsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error("vectors: no JSON files found");
  }

  const seenVectorIds = new Map();
  const seenSuiteIds = new Map();
  const suites = [];

  for (const fileName of files) {
    const relativePath = path.join("vectors", fileName);
    const absolutePath = path.join(vectorsDir, fileName);
    let suite;

    try {
      suite = JSON.parse(await readFile(absolutePath, "utf8"));
    } catch (error) {
      throw new Error(`${relativePath}: invalid JSON: ${error.message}`);
    }

    suites.push(validateSuite(relativePath, suite, seenVectorIds, seenSuiteIds));
  }

  const categories = {};
  const suiteCategories = {};
  const operations = {};
  for (const suite of suites) {
    suiteCategories[suite.category] = (suiteCategories[suite.category] ?? 0) + 1;
    for (const vector of suite.vectors) {
      categories[vector.category] = (categories[vector.category] ?? 0) + 1;
      operations[vector.operation] = (operations[vector.operation] ?? 0) + 1;
    }
  }

  const vectorCount = suites.reduce((total, suite) => total + suite.vectorCount, 0);
  console.log(JSON.stringify({ ok: true, schemaVersion: 1, vectorCount, suites, suiteCategories, categories, operations }, null, 2));
} catch (error) {
  fail(error.message);
}
