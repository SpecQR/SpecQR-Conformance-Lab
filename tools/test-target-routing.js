import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sentinel = "TARGET_ROUTING_NEGATIVE_CONTROL";
const fixtureVersion = "0.0.0-target-routing-test";
const cwd = fileURLToPath(new URL("../", import.meta.url));

function vectors() {
  return ["generate", "generateSegments"].map((operation) => ({
    id: `test.target-routing.${operation}`,
    title: `Selected package ${operation}`,
    category: "reference-matrix",
    operation,
    input: operation === "generate"
      ? { text: "01234567" }
      : { segments: [{ mode: "numeric", text: "01234567" }] },
    options: {
      version: 1,
      errorCorrectionLevel: "L",
      maskPattern: 0,
      mode: "numeric"
    },
    expect: {
      decode: { text: "01234567" },
      diagnostics: { subset: { version: 1 } },
      referenceMatrix: { adapter: "nayuki", exact: true, scope: "fixed-version-ecc-mask" }
    }
  }));
}

async function probe() {
  // Import only inside the child process, after its target environment is set.
  const [specqr, jsqr, nayuki, zbar, zxing, cli, target, png, decoder] = await Promise.all([
    import("../adapters/specqr.js"),
    import("../adapters/jsqr.js"),
    import("../adapters/nayuki.js"),
    import("../adapters/zbar.js"),
    import("../adapters/zxing-cli.js"),
    import("../adapters/cli-decoder.js"),
    import("./specqr-target.js"),
    import("./png-rgba.js"),
    import("jsqr")
  ]);
  const selected = Boolean(process.env.SPECQR_CONFORMANCE_PACKAGE_ROOT);
  const results = [];
  for (const vector of vectors()) {
    const lanes = {};
    for (const adapter of [specqr.default, jsqr.default, nayuki.default]) {
      const result = await adapter.run(vector);
      lanes[adapter.id] = {
        status: result.status,
        errors: result.checks.flatMap((check) => check.error?.message ? [check.error.message] : [])
      };
    }
    if (selected) {
      // Availability is injected only to reach PNG generation. No native decoder
      // is invoked or credited as passing by this harness regression test.
      for (const adapter of [zbar.default, zxing.default]) {
        let commandCalls = 0;
        const result = await adapter.run(vector, {
          discoverCommand: async () => ({ command: "target-routing-test-decoder" }),
          commandRunner: async () => {
            commandCalls += 1;
            throw new Error("Broken target must fail before the decoder runs");
          }
        });
        lanes[adapter.id] = {
          status: result.status,
          commandCalls,
          errors: result.checks.flatMap((check) => check.error?.message ? [check.error.message] : [])
        };
      }
      try {
        cli.generateDecodePng(vector);
        lanes.cliPng = { status: "unexpected-success" };
      } catch (error) {
        lanes.cliPng = { status: "error", errors: [error.message] };
      }
    } else {
      // Verify the shared native-adapter PNG source with a real independent
      // decoder, without needing a native executable on the test machine.
      const image = png.pngToRgba(cli.generateDecodePng(vector));
      const decoded = decoder.default(image.rgba, image.width, image.height);
      lanes.cliPng = { status: decoded?.data === vector.expect.decode.text ? "passed" : "failed" };
    }
    results.push({ operation: vector.operation, lanes });
  }
  return { version: (await target.readSpecqrPackageMetadata()).version, results };
}

function runProbe(env) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--probe"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_000_000
  });
  assert.equal(result.status, 0, `target routing probe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function main() {
  const env = { ...process.env };
  delete env.SPECQR_CONFORMANCE_PACKAGE_ROOT;
  const baseline = runProbe(env);
  assert.notEqual(baseline.version, fixtureVersion);
  for (const { operation, lanes } of baseline.results) {
    for (const [name, result] of Object.entries(lanes)) {
      assert.equal(result.status, "passed", `${name} ${operation} must pass on the real baseline`);
    }
  }

  const packageRoot = await mkdtemp(path.join(tmpdir(), "specqr-target-routing-"));
  try {
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "specqr",
      version: fixtureVersion,
      type: "module",
      exports: { ".": "./index.js", "./browser": "./index.js", "./node": "./index.js" }
    }));
    await writeFile(path.join(packageRoot, "index.js"), [
      `export function generate() { throw new Error(${JSON.stringify(`${sentinel}:generate`)}); }`,
      `export function generateSegments() { throw new Error(${JSON.stringify(`${sentinel}:generateSegments`)}); }`,
      ""
    ].join("\n"));
    const broken = runProbe({ ...env, SPECQR_CONFORMANCE_PACKAGE_ROOT: packageRoot });
    assert.equal(broken.version, fixtureVersion);
    for (const { operation, lanes } of broken.results) {
      for (const [name, result] of Object.entries(lanes)) {
        assert.equal(result.status, "error", `${name} ${operation} must reject the deliberately broken selected target`);
        assert.deepEqual(result.errors, [`${sentinel}:${operation}`], `${name} must expose the selected target's failure`);
        if (Object.hasOwn(result, "commandCalls")) {
          assert.equal(result.commandCalls, 0, "Native decoder must not run after target generation fails");
        }
      }
    }
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    ok: true,
    test: "selected-package-routing",
    baselineVersion: baseline.version,
    operations: baseline.results.map((result) => result.operation),
    negativeControl: "Every generation lane rejects the deliberately broken selected package"
  }, null, 2));
}

try {
  if (process.argv[2] === "--probe") {
    console.log(JSON.stringify(await probe()));
  } else {
    await main();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
