import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentManifest, contentSha256, manifestContentSha256, semanticSha256, semanticReportSha256 } from "./report-provenance.js";
import { createReportMetadata } from "./report-metadata.js";
import { parseCliArgs } from "./run-conformance.js";
import { publicTextProblems } from "./verify-public-output.js";

const root = await mkdtemp(path.join(tmpdir(), "lab-provenance-test-"));
try {
  for (const dir of ["left", "right"]) {
    await mkdir(path.join(root, dir));
    await writeFile(path.join(root, dir, "package.json"), '{"version":"1.0.0"}\n');
    await writeFile(path.join(root, dir, "index.js"), 'export const value = 1;\n');
  }
  const original = await contentSha256(path.join(root, "left"));
  assert.equal(original, manifestContentSha256((await contentManifest(path.join(root, "left"))).reverse().map((entry) => ({...entry,size:0}))), "registry manifest order and sizes do not change the content digest");
  assert.equal(original, await contentSha256(path.join(root, "right")), "package digest is independent of machine path");
  await writeFile(path.join(root, "right", "index.js"), 'export const value = 2;\n');
  assert.notEqual(original, await contentSha256(path.join(root, "right")), "same-version package mutation changes digest");
  assert.equal(semanticSha256({a: 1, b: 2}), semanticSha256({b: 2, a: 1}));
  assert.notEqual(semanticSha256({a: [1,2]}), semanticSha256({a: [2,1]}));
  const metadata = await createReportMetadata();
  await assert.rejects(() => createReportMetadata({packageRoots:{specqr:path.resolve("node_modules/jsqr")}}), /differs from the executing adapter target/);
  await assert.rejects(() => createReportMetadata({env:{SPECQR_CONFORMANCE_PACKAGE_ROOT:path.resolve("node_modules/jsqr")}}), /differs from the executing adapter target/);
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  for (const [name, value] of Object.entries(metadata.provenance.packages)) {
    assert.match(value.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(value.version, metadata.packages[name]);
    assert.equal(value.lockIntegrity, lock.packages[`node_modules/${name}`].integrity);
  }
  assert.equal(metadata.provenance.subjectRouting.contentSha256, metadata.provenance.packages.specqr.contentSha256);
  assert.equal(metadata.provenance.subjectRouting.packageVersion, metadata.packages.specqr);
  const serial = JSON.stringify(metadata.provenance);
  assert.ok(!serial.includes(process.cwd()) && !serial.includes(root), "public provenance has no absolute paths");
  const report = {schemaVersion: 1, labVersion: "0.1.0", status: "executed", run: {mode:"full",filters:{},outputPath:"one.json"}, target: {}, adapters: [], suites: [], summary: {}, results: []};
  const digest = semanticReportSha256(report);
  const moved = structuredClone(report);
  moved.run.outputPath = "two.json";
  moved.metadata = {generatedAt: "tomorrow", runtime: {node: "another-runtime"}};
  assert.equal(digest, semanticReportSha256(moved), "time, runtime and output path do not alter semantic result fingerprint");
  moved.results.push({status: "failed"});
  assert.notEqual(digest, semanticReportSha256(moved), "result mutation changes semantic fingerprint");
  parseCliArgs(["--suite", "core"]);
  assert.deepEqual(parseCliArgs([]).filters, {suites: [], categories: [], adapters: [], vectors: []}, "successive CLI parses do not share filters");
  assert.deepEqual(publicTextProblems("portable/input.png", {env:{}}), []);
  assert.ok(publicTextProblems("/home/example/private/input.png", {env:{}}).includes("absolute machine path"));
  assert.ok(publicTextProblems("secret-fixture-value", {env:{API_TOKEN:"secret-fixture-value"}}).includes("credential value"));
  console.log(JSON.stringify({ok:true, suite:"portable-provenance", controls:16}));
} finally {
  await rm(root, {recursive:true,force:true});
}
