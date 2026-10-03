import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nayukiAdapter, { compareMatrixRows, matrixRows, matrixSha256 } from "../adapters/nayuki.js";
import { generate, generateSegments, readSpecqrPackageMetadata, specqrTargetRoot } from "./specqr-target.js";

// This hash identifies the independently published oracle, not a SpecQR output.
const oracleSourceSha256 = "daa3aa30adbaf99c4e415f33b9042767e74f053896e55ad06f898d344917d2a7";
const oracleIntegrity = "sha512-wnpXdJ+zJ+8QzzGJTEnESaRYfNIUHSgX4ykvYuaomqqUbhJdun3v0sK/39BQjw3on/vf7ujPKIg2V07WejjmLw==";
const require = createRequire(import.meta.url);
const sourcePath = require.resolve("nayuki-qr-code-generator");
const source = await readFile(sourcePath);
const oraclePackage = JSON.parse(await readFile(path.join(path.dirname(sourcePath), "package.json"), "utf8"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.equal(oraclePackage.version, "1.8.0");
assert.equal(packageJson.devDependencies["nayuki-qr-code-generator"], "1.8.0");
assert.equal(lockfile.packages["node_modules/nayuki-qr-code-generator"].integrity, oracleIntegrity);
assert.equal(createHash("sha256").update(source).digest("hex"), oracleSourceSha256);

// The npm wrapper contains ESM without declaring type:module. Loading its exact
// bytes by a data URL works on supported Node versions without rewriting it.
const oracle = await import(`data:text/javascript;base64,${source.toString("base64")}`);
const { QrCode, QrSegment } = oracle.default ?? oracle;
const ecc = { L: QrCode.Ecc.LOW, M: QrCode.Ecc.MEDIUM, Q: QrCode.Ecc.QUARTILE, H: QrCode.Ecc.HIGH };
const suite = JSON.parse(await readFile(new URL("../vectors/reference-nayuki.json", import.meta.url), "utf8"));
const vectors = suite.vectors;

function bytes(input) {
  return Object.hasOwn(input, "binaryHex")
    ? Array.from(Buffer.from(input.binaryHex, "hex"))
    : Array.from(new TextEncoder().encode(input.text));
}

function segment(mode, input) {
  if (mode === "numeric") return QrSegment.makeNumeric(input.text);
  if (mode === "alphanumeric") return QrSegment.makeAlphanumeric(input.text);
  assert.equal(mode, "byte", "reference fixtures require an explicit supported segment mode");
  return QrSegment.makeBytes(bytes(input));
}

function referenceRows(vector) {
  const { version, errorCorrectionLevel, maskPattern, eci, mode } = vector.options;
  const segments = vector.operation === "generateSegments"
    ? vector.input.segments.map((input) => segment(input.mode, input))
    : [segment(Object.hasOwn(vector.input, "binaryHex") ? "byte" : mode, vector.input)];
  if (eci !== undefined) {
    assert.equal(eci, 26, "only the supported ECI 26 reference scope is claimed");
    segments.unshift(QrSegment.makeEci(26));
  }
  const qr = QrCode.encodeSegments(segments, ecc[errorCorrectionLevel], version, version, maskPattern, false);
  return Array.from({ length: qr.size }, (_, y) =>
    Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y) ? "1" : "0").join(""));
}

function targetMatrix(vector) {
  const options = { ...vector.options, output: "matrix", diagnostics: true, boostErrorCorrection: false };
  return vector.operation === "generateSegments"
    ? generateSegments(vector.input.segments, options).matrix
    : generate(Object.hasOwn(vector.input, "binaryHex")
      ? new Uint8Array(Buffer.from(vector.input.binaryHex, "hex")) : vector.input.text, options).matrix;
}

// Check the committed coverage itself so a removed vector cannot silently turn
// a passing test run into narrower evidence.
for (const level of ["L", "M", "Q", "H"]) {
  for (let mask = 0; mask < 8; mask += 1) {
    assert(vectors.some((vector) => vector.options.version === 1 && vector.options.mode === "numeric"
      && vector.options.errorCorrectionLevel === level && vector.options.maskPattern === mask),
    `missing numeric ECC/mask pair ${level}/${mask}`);
  }
}
for (const version of [6, 7, 9, 10, 26, 27]) {
  const vector = vectors.find((item) => item.options.version === version && item.operation === "generateSegments");
  assert(vector, `missing boundary version ${version}`);
  assert.deepEqual(vector.input.segments.map((item) => item.mode), ["numeric", "alphanumeric", "byte"]);
}
for (const [mode, widths] of [[QrSegment.Mode.NUMERIC, [10, 12, 12, 14]],
  [QrSegment.Mode.ALPHANUMERIC, [9, 11, 11, 13]], [QrSegment.Mode.BYTE, [8, 16, 16, 16]]]) {
  assert.deepEqual([9, 10, 26, 27].map((version) => mode.numCharCountBits(version)), widths);
}

let totalModules = 0;
for (const vector of vectors) {
  const rows = referenceRows(vector);
  const result = await nayukiAdapter.run(vector);
  assert.equal(result.status, "passed", `${vector.id}: ${JSON.stringify(result)}`);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].name, "referenceMatrix.exact");
  assert.equal(result.checks[0].status, "passed");
  assert.equal(result.details.size, 17 + 4 * vector.options.version);
  assert.equal(result.details.version, vector.options.version);
  assert.equal(result.details.errorCorrectionLevel, vector.options.errorCorrectionLevel);
  assert.equal(result.details.maskPattern, vector.options.maskPattern);
  assert.equal(result.details.nayukiMatrixSha256, matrixSha256(rows), `${vector.id}: oracle hash`);
  assert.equal(result.details.specqrMatrixSha256, matrixSha256(rows), `${vector.id}: target hash`);
  totalModules += rows.length ** 2;
}

let negativeControls = 0;
for (const [version, level, byteLength] of [[1, "H", 7], [40, "L", 2953], [40, "H", 1273]]) {
  const vector = vectors.find((item) => item.options.version === version
    && item.options.errorCorrectionLevel === level && item.tags.includes("exact-capacity"));
  assert(vector, `missing exact byte capacity ${version}-${level}`);
  assert.equal(vector.input.binaryHex.length / 2, byteLength);
  const tooLong = structuredClone(vector);
  tooLong.input.binaryHex += "00";
  // Independent acceptance at n bytes and independent rejection at n+1 establish
  // the capacity boundary; no SpecQR capacity API supplies the expected value.
  assert.throws(() => referenceRows(tooLong), /Data too long/);
  assert.throws(() => targetMatrix(tooLong));
  negativeControls += 1;
}

const baseline = vectors.find((vector) => vector.id === "reference.nayuki.numeric.v1-l-mask0");
assert(baseline);
const expected = referenceRows(baseline);
const target = matrixRows(targetMatrix(baseline));
assert(compareMatrixRows(expected, target).ok);
const corrupted = target.slice();
const x = 10;
const y = 10;
corrupted[y] = `${corrupted[y].slice(0, x)}${corrupted[y][x] === "1" ? "0" : "1"}${corrupted[y].slice(x + 1)}`;
const mismatch = compareMatrixRows(expected, corrupted);
assert.equal(mismatch.ok, false, "single-module corruption must fail");
assert.equal(mismatch.firstMismatch.x, x);
assert.equal(mismatch.firstMismatch.y, y);
assert.notEqual(matrixSha256(expected), matrixSha256(corrupted));
negativeControls += 1;
const changedPayload = structuredClone(baseline);
changedPayload.input.text = "01234568";
const changed = matrixRows(targetMatrix(changedPayload));
assert.equal(compareMatrixRows(expected, changed).ok, false, "different payload must fail against the original oracle");
assert.notEqual(matrixSha256(expected), matrixSha256(changed));
negativeControls += 1;

// Route a deliberately corrupted public-API wrapper through the real adapter.
// This control detects a self-comparison or a lane bypassing the selected target,
// not just a defect in the standalone matrix comparator.
const corruptedTarget = await mkdtemp(path.join(tmpdir(), "specqr-reference-negative-"));
try {
  const targetPackage = await readSpecqrPackageMetadata();
  const targetRoot = specqrTargetRoot ?? fileURLToPath(new URL("../node_modules/specqr/", import.meta.url));
  function publicExportUrl(subpath) {
    const entry = targetPackage.exports[subpath];
    return pathToFileURL(path.resolve(targetRoot, typeof entry === "string" ? entry : entry.import)).href;
  }
  const rootUrl = publicExportUrl(".");
  await writeFile(path.join(corruptedTarget, "package.json"), JSON.stringify({
    name: "specqr", version: "0.0.0-reference-negative-control", type: "module",
    exports: { ".": "./root.js", "./browser": "./browser.js", "./node": "./node.js" }
  }));
  await writeFile(path.join(corruptedTarget, "root.js"), `
export * from ${JSON.stringify(rootUrl)};
import { generate as originalGenerate, generateSegments as originalGenerateSegments } from ${JSON.stringify(rootUrl)};
function corrupt(result) {
  result.matrix[10][10] = !result.matrix[10][10];
  return result;
}
export const generate = (...args) => corrupt(originalGenerate(...args));
export const generateSegments = (...args) => corrupt(originalGenerateSegments(...args));
`);
  for (const subpath of ["browser", "node"]) {
    await writeFile(path.join(corruptedTarget, `${subpath}.js`),
      `export * from ${JSON.stringify(publicExportUrl(`./${subpath}`))};\n`);
  }
  const manual = vectors.find((vector) => vector.operation === "generateSegments");
  assert(manual);
  const probe = spawnSync(process.execPath, ["--input-type=module", "-"], {
    env: { ...process.env, SPECQR_CONFORMANCE_PACKAGE_ROOT: corruptedTarget },
    input: `import adapter from ${JSON.stringify(new URL("../adapters/nayuki.js", import.meta.url).href)};
const results = [];
for (const vector of ${JSON.stringify([baseline, manual])}) results.push(await adapter.run(vector));
console.log(JSON.stringify(results));`,
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(probe.status, 0, `corrupted target probe failed: ${probe.stderr}`);
  const results = JSON.parse(probe.stdout);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, "failed", "a corrupted target must fail the live reference adapter");
    assert.equal(result.checks[0].name, "referenceMatrix.exact");
    assert.equal(result.checks[0].status, "failed");
    assert.equal(result.details.firstMismatch.x, 10);
    assert.equal(result.details.firstMismatch.y, 10);
    assert.notEqual(result.details.specqrMatrixSha256, result.details.nayukiMatrixSha256);
    negativeControls += 1;
  }
} finally {
  await rm(corruptedTarget, { recursive: true, force: true });
}

const outsideScope = [
  { options: { ...baseline.options, mode: "auto" } },
  { input: { text: "漢字" }, options: { ...baseline.options, mode: "kanji" } },
  { options: { ...baseline.options, gs1: true } },
  { options: { ...baseline.options, fnc1Second: 1 } },
  { options: { ...baseline.options, eci: 3 } },
  { operation: "structuredAppend.generate" }
];
for (const overrides of outsideScope) {
  const result = await nayukiAdapter.run({ ...structuredClone(baseline), ...overrides });
  assert.equal(result.status, "skipped", `unsupported scope must be skipped: ${JSON.stringify(overrides)}`);
  assert(result.checks.every((check) => check.status === "skipped"));
  negativeControls += 1;
}

console.log(JSON.stringify({
  ok: true,
  oracle: { package: "nayuki-qr-code-generator", version: oraclePackage.version, sourceSha256: oracleSourceSha256 },
  vectors: vectors.length,
  comparedModules: totalModules,
  eccMaskPairs: 32,
  boundaryVersions: [6, 7, 9, 10, 26, 27],
  capacityCases: 3,
  negativeControls
}, null, 2));
