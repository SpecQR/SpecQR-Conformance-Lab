import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { compareReports } from "./compare-reports.js";

export const schemaFiles = {
  vectorSuite: "schemas/vector-suite-v1.schema.json",
  conformanceReport: "schemas/conformance-report-v1.schema.json",
  badge: "schemas/badge-v1.schema.json",
  reportComparison: "schemas/report-comparison-v1.schema.json"
};

const draft = "https://json-schema.org/draft/2020-12/schema";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
    }).join(",")}}`;
  }

  return JSON.stringify(value);
}

function valueType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

function typeMatches(value, expectedType) {
  switch (expectedType) {
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return typeof value === expectedType;
  }
}

function pointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) {
    throw new Error(`unsupported schema ref ${ref}`);
  }

  const segments = ref.slice(2).split("/").map(pointerSegment);
  let current = rootSchema;
  for (const segment of segments) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) {
      throw new Error(`unresolved schema ref ${ref}`);
    }
    current = current[segment];
  }
  return current;
}

function error(errors, instancePath, message, extra = {}) {
  errors.push({ path: instancePath, message, ...extra });
}

function validateType(value, schema, instancePath, errors) {
  if (!Object.hasOwn(schema, "type")) {
    return true;
  }

  const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (expectedTypes.some((type) => typeMatches(value, type))) {
    return true;
  }

  error(errors, instancePath, `must be ${expectedTypes.join(" or ")}`, {
    actualType: valueType(value)
  });
  return false;
}

function validateString(value, schema, instancePath, errors) {
  if (typeof value !== "string") {
    return;
  }

  if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
    error(errors, instancePath, `must have length >= ${schema.minLength}`);
  }

  if (typeof schema.pattern === "string") {
    const pattern = new RegExp(schema.pattern);
    if (!pattern.test(value)) {
      error(errors, instancePath, `must match pattern ${schema.pattern}`);
    }
  }

  if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
    error(errors, instancePath, "must be a valid date-time string");
  }
}

function validateNumber(value, schema, instancePath, errors) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }

  if (typeof schema.minimum === "number" && value < schema.minimum) {
    error(errors, instancePath, `must be >= ${schema.minimum}`);
  }
}

function validateArray(value, schema, rootSchema, instancePath, errors) {
  if (!Array.isArray(value)) {
    return;
  }

  if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
    error(errors, instancePath, `must have at least ${schema.minItems} item(s)`);
  }

  if (isObject(schema.items) || typeof schema.items === "boolean") {
    for (const [index, item] of value.entries()) {
      validateNode(item, schema.items, rootSchema, `${instancePath}[${index}]`, errors);
    }
  }
}

function validateObject(value, schema, rootSchema, instancePath, errors) {
  if (!isObject(value)) {
    return;
  }

  for (const field of schema.required ?? []) {
    if (!Object.hasOwn(value, field)) {
      error(errors, `${instancePath}.${field}`, "is required");
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      validateNode(value[key], propertySchema, rootSchema, `${instancePath}.${key}`, errors);
    }
  }

  const additionalProperties = schema.additionalProperties;
  if (additionalProperties === undefined || additionalProperties === true) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) {
      continue;
    }
    if (additionalProperties === false) {
      error(errors, `${instancePath}.${key}`, "is not an allowed property");
    } else {
      validateNode(child, additionalProperties, rootSchema, `${instancePath}.${key}`, errors);
    }
  }
}

function validateNode(value, schema, rootSchema, instancePath, errors) {
  if (schema === true || schema === undefined) {
    return;
  }
  if (schema === false) {
    error(errors, instancePath, "is not allowed");
    return;
  }

  if (schema.$ref) {
    validateNode(value, resolveRef(rootSchema, schema.$ref), rootSchema, instancePath, errors);
    return;
  }

  if (Object.hasOwn(schema, "const") && stableStringify(value) !== stableStringify(schema.const)) {
    error(errors, instancePath, `must equal ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum)) {
    const matched = schema.enum.some((entry) => stableStringify(value) === stableStringify(entry));
    if (!matched) {
      error(errors, instancePath, `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
    }
  }

  const typeOk = validateType(value, schema, instancePath, errors);
  if (!typeOk) {
    return;
  }

  validateString(value, schema, instancePath, errors);
  validateNumber(value, schema, instancePath, errors);
  validateArray(value, schema, rootSchema, instancePath, errors);
  validateObject(value, schema, rootSchema, instancePath, errors);
}

export function validateSchemaValue(value, schema, options = {}) {
  const errors = [];
  validateNode(value, schema, schema, options.path ?? "$", errors);
  return {
    ok: errors.length === 0,
    errors
  };
}

export async function readJsonFile(filePath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const absolutePath = path.resolve(cwd, filePath);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON: ${error.message}`);
  }
}

async function fileExists(filePath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  try {
    await access(path.resolve(cwd, filePath));
    return true;
  } catch {
    return false;
  }
}

export async function loadSchemas(options = {}) {
  const schemas = {};
  for (const [key, filePath] of Object.entries(schemaFiles)) {
    schemas[key] = await readJsonFile(filePath, options);
  }
  return schemas;
}

async function validateJsonFile(filePath, schema, schemaName, options = {}) {
  const value = await readJsonFile(filePath, options);
  const result = validateSchemaValue(value, schema);
  return {
    ok: result.ok,
    file: filePath,
    schema: schemaName,
    value,
    errors: result.errors.map((validationError) => ({
      file: filePath,
      schema: schemaName,
      ...validationError
    }))
  };
}

function pushResult(summary, validation) {
  if (validation.ok) {
    summary.validated.push({
      file: validation.file,
      schema: validation.schema
    });
  } else {
    summary.errors.push(...validation.errors);
  }
}

async function vectorFiles(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const entries = await readdir(path.resolve(cwd, "vectors"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join("vectors", entry.name))
    .sort();
}

async function badgeFiles(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const entries = await readdir(path.resolve(cwd, "badges"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join("badges", entry.name))
    .sort();
}

export async function validateAllSchemas(options = {}) {
  const schemas = await loadSchemas(options);
  const summary = {
    ok: true,
    schemaDraft: draft,
    schemas: Object.values(schemaFiles),
    validated: [],
    errors: []
  };

  for (const filePath of await vectorFiles(options)) {
    pushResult(summary, await validateJsonFile(filePath, schemas.vectorSuite, schemaFiles.vectorSuite, options));
  }

  const reportPath = options.reportPath ?? "reports/latest.json";
  const reportValidation = await validateJsonFile(reportPath, schemas.conformanceReport, schemaFiles.conformanceReport, options);
  pushResult(summary, reportValidation);

  for (const filePath of await badgeFiles(options)) {
    pushResult(summary, await validateJsonFile(filePath, schemas.badge, schemaFiles.badge, options));
  }

  const report = reportValidation.value;
  const selfComparison = compareReports(report, report);
  const selfComparisonResult = validateSchemaValue(selfComparison, schemas.reportComparison);
  pushResult(summary, {
    ok: selfComparisonResult.ok,
    file: "self-comparison:reports/latest.json",
    schema: schemaFiles.reportComparison,
    errors: selfComparisonResult.errors.map((validationError) => ({
      file: "self-comparison:reports/latest.json",
      schema: schemaFiles.reportComparison,
      ...validationError
    }))
  });

  const comparisonPath = options.comparisonPath ?? "reports/comparison.json";
  if (await fileExists(comparisonPath, options)) {
    pushResult(
      summary,
      await validateJsonFile(comparisonPath, schemas.reportComparison, schemaFiles.reportComparison, options)
    );
  }

  summary.ok = summary.errors.length === 0;
  return summary;
}

function summarize(summary) {
  const counts = {
    vectors: summary.validated.filter((entry) => entry.schema === schemaFiles.vectorSuite).length,
    reports: summary.validated.filter((entry) => entry.schema === schemaFiles.conformanceReport).length,
    badges: summary.validated.filter((entry) => entry.schema === schemaFiles.badge).length,
    comparisons: summary.validated.filter((entry) => entry.schema === schemaFiles.reportComparison).length
  };

  return {
    ok: summary.ok,
    schemaDraft: summary.schemaDraft,
    schemas: summary.schemas,
    counts,
    validated: summary.validated,
    errors: summary.errors
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const summary = summarize(await validateAllSchemas());
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  }
}
