import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generate, generateSegments } from "specqr";
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

function errorObject(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name ?? "Error",
    code: error.code ?? null,
    message: error.message ?? String(error),
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

function trimOutput(value) {
  const text = String(value ?? "");
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function commandDetails(command, args, result = {}) {
  return {
    command,
    args,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr)
  };
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
        actual: decodedText
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
  const commands = adapterConfig.commands.map((candidate) => normalizeCommandCandidate(candidate).command);
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
    commandCandidates: adapterConfig.commands.map((candidate) => normalizeCommandCandidate(candidate).command),
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
            command: commandDetails(command.command, args, result),
            decoded: decodedText === null || decodedText === undefined ? null : { text: decodedText }
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
            error: errorObject(error)
          }],
          reason: `${adapterConfig.name} optional lane failed while generating or decoding PNG`
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  };
}
