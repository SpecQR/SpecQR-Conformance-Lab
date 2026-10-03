import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import process from "node:process";
import zbar from "../adapters/zbar.js";
import zxing from "../adapters/zxing-cli.js";
import { createOptionalCliDecodeAdapter } from "../adapters/cli-decoder.js";

const privateMarker = "PRIVATE_PROCESS_LOG_NEGATIVE_CONTROL";
const vector = {
  id: "test.cli-public-evidence",
  title: "CLI public evidence hygiene",
  category: "core",
  operation: "generate",
  input: { text: "PUBLIC FIXTURE" },
  options: {},
  expect: { decode: { text: "PUBLIC FIXTURE" } }
};

for (const adapter of [zbar, zxing]) {
  for (const ok of [true, false]) {
    let temporaryInput;
    const result = await adapter.run(vector, {
      commandRunner: async (command, args) => {
        const input = args.find((arg) => arg.endsWith(".png"));
        if (input) temporaryInput = input;
        return {
          ok,
          unavailable: false,
          exitCode: ok ? 0 : 2,
          signal: null,
          stdout: input
            ? (ok ? (adapter.id === "zbarimg" ? "PUBLIC FIXTURE\n" : `Text: "PUBLIC FIXTURE"\nFile: ${input}\n${privateMarker}\n`) : privateMarker)
            : privateMarker,
          stderr: `${privateMarker}: ${process.cwd()} ${homedir()} ${input ?? ""}`
        };
      }
    });
    assert.equal(result.status, ok ? "passed" : "failed");
    const serialized = JSON.stringify(result);
    for (const privateValue of [privateMarker, temporaryInput, process.cwd(), homedir()]) {
      assert(!serialized.includes(privateValue), `${adapter.id} report must omit raw logs and machine paths`);
    }
    assert(result.details.command.args.includes("input.png"));
    assert.equal(result.details.command.exitCode, ok ? 0 : 2);
    assert(result.details.command.stdoutBytes > 0);
    assert(result.details.command.stderrBytes > 0);
    assert.equal(result.details.command.version, null);
    assert.equal(result.details.command.versionSource, "unknown");
    assert(!Object.hasOwn(result.details.command, "stdout"));
    assert(!Object.hasOwn(result.details.command, "stderr"));
    assert.deepEqual(result.details.decoded, ok ? { text: "PUBLIC FIXTURE" } : null);
  }

  const exception = await adapter.run(vector, {
    discoverCommand: async () => ({ command: "fixture-decoder" }),
    commandRunner: async (_command, args) => {
      throw new Error(`fixture error reading ${args[0]} from ${process.cwd()} under ${homedir()}`);
    }
  });
  assert.equal(exception.status, "error");
  assert(exception.checks[0].error.message.includes("[temporary-input]/input.png"));
  assert(!JSON.stringify(exception).includes(process.cwd()));
  assert(!JSON.stringify(exception).includes(homedir()));

  const privatePayload = `WARNING ${privateMarker} at ${homedir()}/local-secret`;
  for (const expectDecode of [
    vector.expect.decode,
    { binaryHex: "00" },
    { text: `WARNING ${privateMarker} at [home]/local-secret` }
  ]) {
    const mismatch = await adapter.run({ ...vector, expect: { decode: expectDecode } }, {
      discoverCommand: async () => ({ command: "fixture-decoder" }),
      commandRunner: async () => ({
        ok: true,
        unavailable: false,
        exitCode: 0,
        stdout: `${privatePayload}\n`,
        stderr: ""
      })
    });
    const fingerprint = {
      textRedacted: true,
      byteLength: Buffer.byteLength(privatePayload, "utf8"),
      sha256: createHash("sha256").update(privatePayload, "utf8").digest("hex")
    };
    assert.equal(mismatch.status, Object.hasOwn(expectDecode, "text") ? "failed" : "skipped");
    assert.deepEqual(mismatch.details.decoded, fingerprint);
    assert(!JSON.stringify(mismatch.details).includes(privateMarker));
    assert(!JSON.stringify(mismatch).includes(homedir()));
    if (Object.hasOwn(expectDecode, "text")) {
      assert.deepEqual(mismatch.checks.find((check) => check.name === "decode.text").actual, fingerprint);
    }
  }
}

const absoluteCommand = `${homedir()}/private-tools/fixture-decoder`;
const customAdapter = createOptionalCliDecodeAdapter({
  id: "fixture-native",
  name: "Fixture native decoder",
  commands: [absoluteCommand],
  parseOutput: (stdout) => stdout
});
const unavailable = await customAdapter.run(vector, { discoverCommand: async () => null });
assert.equal(unavailable.status, "skipped");
assert.deepEqual(unavailable.details.availability.commands, ["fixture-decoder"]);
assert.deepEqual(customAdapter.commandCandidates, ["fixture-decoder"]);
assert(!JSON.stringify(unavailable).includes(homedir()));

for (const [probeOutput, expectedVersion] of [
  ["0.23.93\n", "0.23.93"],
  ["zbarimg 0.23.93\n", "0.23.93"],
  [`0.23.93\n${privateMarker}\n`, null]
]) {
  const result = await zbar.run(vector, {
    commandRunner: async (_command, args) => ({
      ok: true,
      unavailable: false,
      exitCode: 0,
      stdout: args.includes("--version") ? probeOutput : "PUBLIC FIXTURE\n",
      stderr: ""
    })
  });
  assert.equal(result.details.command.version, expectedVersion);
  assert.equal(result.details.command.versionSource, expectedVersion ? "--version" : "unknown");
  assert(!JSON.stringify(result).includes(privateMarker));
}

const helpOnly = await zxing.run(vector, {
  commandRunner: async (_command, args) => ({
    ok: true,
    unavailable: false,
    exitCode: 0,
    stdout: args.includes("--help") ? "ZXingReader 2.3.0\n" : 'Text: "PUBLIC FIXTURE"\n',
    stderr: ""
  })
});
assert.equal(helpOnly.details.command.version, null, "A help probe does not certify the installed version");

console.log(JSON.stringify({
  ok: true,
  test: "cli-public-evidence",
  adapters: [zbar.id, zxing.id],
  cases: ["parsed-payload", "decoder-failure", "exception-path-redaction", "explicit-version-probe", "successful-exit-private-payload", "unavailable-command-path"],
  nativeDecodersExecuted: false
}, null, 2));
