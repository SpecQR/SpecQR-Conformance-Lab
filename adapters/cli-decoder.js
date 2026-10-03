import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { generate, generateSegments } from "../tools/specqr-target.js";
import { binaryHexToBytes, summarizeChecks } from "./specqr.js";

const supportedOperations = new Set(["generate", "generateSegments"]);

export function supportsDecodeOperation(operation) {
  return supportedOperations.has(operation);
}

export function isStructuredAppendOperation(operation) {
  return typeof operation === "string" && operation.startsWith("structuredAppend.");
}

export function createSkippedCheck(name, reason) {
  return {
    name,
    status: "skipped",
    reason
  };
}

export function createPassedCheck(name, details = {}) {
  return {
    name,
    status: "passed",
    ...details
  };
}

export function createFailedCheck(name, reason, details = {}) {
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

function pngOptions(options = {}) {
  return {
    ...options,
    scale: options.scale ?? 12,
    margin: options.margin ?? 4,
    output: "png",
    diagnostics: false
  };
}

export function generateDecodePng(vector) {
  if (vector.operation === "generate") {
    return generate(normalizeInput(vector.input), pngOptions(vector.options));
  }

  return generateSegments(normalizeSegments(vector.input.segments), pngOptions(vector.options));
}

function portableDiagnostic(value, temporaryDirectory) {
  let text = String(value ?? "");
  for (const [source, replacement] of [
    [temporaryDirectory, "[temporary-input]"],
    [process.cwd(), "[workspace]"],
    [homedir(), "[home]"]
  ]) {
    if (source && source !== path.parse(source).root) {
      text = text.replaceAll(source, replacement);
    }
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function errorObject(error, temporaryDirectory) {
  if (!error) {
    return null;
  }

  return {
    name: error.name ?? "Error",
    code: error.code ?? null,
    message: portableDiagnostic(error.message ?? String(error), temporaryDirectory),
    signal: error.signal ?? null
  };
}

export function runExternalCommand(command, args, options = {}) {
  const timeout = options.timeoutMs ?? 5000;
  const maxBuffer = options.maxBuffer ?? 1_000_000;

  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout, maxBuffer }, (error, stdout, stderr) => {
      const unavailable = error?.code === "ENOENT" || error?.code === "EACCES";
      resolve({
        command,
        args,
        ok: !error,
        unavailable,
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        signal: error?.signal ?? null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        error: errorObject(error)
      });
    });
  });
}

export function normalizeCommandCandidate(candidate) {
  if (typeof candidate === "string") {
    return {
      command: candidate,
      discoveryArgs: ["--help"],
      decodeArgs: (pngPath) => [pngPath]
    };
  }

  return {
    discoveryArgs: ["--help"],
    decodeArgs: (pngPath) => [pngPath],
    ...candidate
  };
}

export async function discoverCommand(candidates, options = {}) {
  const commandRunner = options.commandRunner ?? runExternalCommand;

  for (const candidate of candidates.map(normalizeCommandCandidate)) {
    const probe = await commandRunner(candidate.command, candidate.discoveryArgs, {
      timeoutMs: options.discoveryTimeoutMs ?? 1500
    });
    if (!probe.unavailable) {
      return {
        ...candidate,
        probe
      };
    }
  }

  return null;
}

function commandDisplayName(command) {
  return path.win32.basename(path.basename(command));
}

function commandVersion(candidate) {
  // Do not infer a decoder version from arbitrary --help output. A successful
  // explicit version probe must contain only a version (optionally prefixed by
  // this executable's name), so probe logs never enter public evidence.
  const unknown = { version: null, versionSource: "unknown" };
  if (!candidate.discoveryArgs?.includes("--version") || !candidate.probe?.ok) {
    return unknown;
  }
  const command = commandDisplayName(candidate.command);
  let output = String(candidate.probe.stdout ?? "").trim();
  if (output.startsWith(`${command} `)) {
    output = output.slice(command.length + 1).trim();
  }
  const match = output.match(/^v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/u);
  return match ? { version: match[1], versionSource: "--version" } : unknown;
}

function commandDetails(candidate, args, result = {}, pngPath) {
  return {
    command: commandDisplayName(candidate.command),
    ...commandVersion(candidate),
    args: args.map((arg) => arg === pngPath ? "input.png" : portableDiagnostic(arg)),
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    // The parsed payload is evidence; raw process logs can contain private
    // machine paths or unrelated diagnostics and do not belong in a report.
    stdoutBytes: Buffer.byteLength(String(result.stdout ?? ""), "utf8"),
    stderrBytes: Buffer.byteLength(String(result.stderr ?? ""), "utf8")
  };
}

function decodedTextFingerprint(decodedText) {
  const text = String(decodedText);
  return {
    textRedacted: true,
    byteLength: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex")
  };
}

function decodedEvidence(expectDecode, decodedText) {
  if (decodedText === null || decodedText === undefined) {
    return null;
  }
  // Preserve raw equality for the verdict. Only a payload matching an explicit
  // public expectation is safe to echo; parsers can mistake diagnostics for QR
  // content even when the native command exits successfully.
  return Object.hasOwn(expectDecode, "text") && decodedText === expectDecode.text
    ? { text: decodedText }
    : decodedTextFingerprint(decodedText);
}

export function evaluateCliDecodeExpectation(expectDecode, decodedText, options = {}) {
  const checks = [];
  const adapterName = options.adapterName ?? "CLI decoder";
  const rawBinaryReason = options.rawBinaryReason ?? `${adapterName} does not expose reliable raw bytes.`;

  if (Object.hasOwn(expectDecode, "text")) {
    if (decodedText === null || decodedText === undefined) {
      checks.push(createFailedCheck("decode.read", `${adapterName} could not decode text from the generated PNG.`));
    } else if (decodedText === expectDecode.text) {
      checks.push(createPassedCheck("decode.text"));
    } else {
      checks.push(createFailedCheck("decode.text", "decoded text differs", {
        expected: expectDecode.text,
        actual: decodedTextFingerprint(decodedText)
      }));
    }
  }

  if (Object.hasOwn(expectDecode, "binaryHex")) {
    checks.push(createSkippedCheck("decode.binaryHex", rawBinaryReason));
  }

  if (checks.length === 0) {
    checks.push(createSkippedCheck("decode", `${adapterName} が比較できる decode expectation field がありません。`));
  }

  return checks;
}

function noDecodeExpectationResult(adapterConfig, vector) {
  return {
    vectorId: vector.id,
    adapterId: adapterConfig.id,
    status: "skipped",
    checks: [createSkippedCheck("decode", "decode expectation がないため optional CLI decoder lane は実行しません。")],
    reason: "No decode expectation"
  };
}

function unavailableResult(adapterConfig, vector) {
  const commands = adapterConfig.commands.map((candidate) => commandDisplayName(normalizeCommandCandidate(candidate).command));
  const reason = `${adapterConfig.name} command is not available; install one of ${commands.join(", ")} to enable this optional lane.`;
  return {
    vectorId: vector.id,
    adapterId: adapterConfig.id,
    status: "skipped",
    checks: [createSkippedCheck("availability", reason)],
    reason,
    details: {
      availability: {
        optional: true,
        commands
      }
    }
  };
}

export function createOptionalCliDecodeAdapter(adapterConfig) {
  return {
    id: adapterConfig.id,
    name: adapterConfig.name,
    packageName: null,
    packageVersion: null,
    status: "optional",
    required: false,
    lane: "optional-decode-readability",
    commandCandidates: adapterConfig.commands.map((candidate) => commandDisplayName(normalizeCommandCandidate(candidate).command)),
    supportsOperation: supportsDecodeOperation,
    async run(vector, options = {}) {
      if (isStructuredAppendOperation(vector.operation)) {
        return {
          vectorId: vector.id,
          adapterId: adapterConfig.id,
          status: "skipped",
          checks: [createSkippedCheck("operation", "optional CLI decoder lane は Structured Append metadata validation や merge support を主張しません。")],
          reason: `Structured Append operation is outside ${adapterConfig.id} scope: ${vector.operation}`
        };
      }

      if (!supportsDecodeOperation(vector.operation)) {
        return {
          vectorId: vector.id,
          adapterId: adapterConfig.id,
          status: "skipped",
          checks: [createSkippedCheck("operation", `${adapterConfig.name} optional lane は ${vector.operation} を対象外にします。`)],
          reason: `Unsupported operation for ${adapterConfig.id} lane: ${vector.operation}`
        };
      }

      if (!Object.hasOwn(vector.expect, "decode")) {
        return noDecodeExpectationResult(adapterConfig, vector);
      }

      const commandRunner = options.commandRunner ?? runExternalCommand;
      const commandDiscoverer = options.discoverCommand ?? discoverCommand;
      const discovered = await commandDiscoverer(adapterConfig.commands, {
        commandRunner,
        discoveryTimeoutMs: options.discoveryTimeoutMs
      });

      if (!discovered) {
        return unavailableResult(adapterConfig, vector);
      }

      const command = normalizeCommandCandidate(discovered);
      const tempDir = await mkdtemp(path.join(tmpdir(), `${adapterConfig.id}-`));
      const pngPath = path.join(tempDir, "input.png");

      try {
        await writeFile(pngPath, generateDecodePng(vector));
        const args = command.decodeArgs(pngPath);
        const result = await commandRunner(command.command, args, {
          timeoutMs: options.decodeTimeoutMs ?? 5000
        });

        if (result.unavailable) {
          return unavailableResult(adapterConfig, vector);
        }

        const decodedText = result.ok ? adapterConfig.parseOutput(result.stdout, result.stderr, result) : null;
        const checks = evaluateCliDecodeExpectation(vector.expect.decode, decodedText, {
          adapterName: adapterConfig.name,
          rawBinaryReason: adapterConfig.rawBinaryReason
        });
        const status = summarizeChecks(checks);

        return {
          vectorId: vector.id,
          adapterId: adapterConfig.id,
          status,
          checks,
          ...(status === "failed" ? { reason: "one or more optional CLI decode checks failed" } : {}),
          details: {
            command: commandDetails(command, args, result, pngPath),
            decoded: decodedEvidence(vector.expect.decode, decodedText)
          }
        };
      } catch (error) {
        return {
          vectorId: vector.id,
          adapterId: adapterConfig.id,
          status: "error",
          checks: [{
            name: "decode",
            status: "error",
            reason: `${adapterConfig.name} optional lane failed while generating or decoding PNG`,
            error: errorObject(error, tempDir)
          }],
          reason: `${adapterConfig.name} optional lane failed while generating or decoding PNG`
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  };
}
