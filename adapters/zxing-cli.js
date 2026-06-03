import { createOptionalCliDecodeAdapter } from "./cli-decoder.js";

const metadataLinePattern = /^(?:barcode format|bytes|content|ec level|error correction level|file|filename|format|identifier|image|is valid|orientation|position|raw bytes|rotation|symbology|type)\b/i;
const noResultPattern = /^(?:no barcode found|no result|not found|failed to decode)\b/i;
const labelPattern = /^(?:text|parsed result|raw result|result|contents?)\s*[:=]\s*(.*)$/i;
const imagePrefixPattern = /^(?:.+[\\/])?[^:]+\.(?:bmp|gif|jpeg|jpg|png|tif|tiff|webp)\s*:\s*/i;

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

function cleanPayload(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length === 0) {
    return null;
  }

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

function findJsonPayload(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    for (const key of ["text", "Text", "raw", "rawText", "result", "content", "contents"]) {
      if (typeof parsed[key] === "string") {
        return cleanPayload(parsed[key]);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function nextPayloadLine(lines, startIndex) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const candidate = cleanPayload(lines[index]);
    if (!candidate || metadataLinePattern.test(candidate) || noResultPattern.test(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
}

export function parseZxingOutput(stdout, stderr = "") {
  const output = stripAnsi([stdout, stderr].filter(Boolean).join("\n")).replaceAll("\r\n", "\n");
  const jsonPayload = findJsonPayload(output.trim());
  if (jsonPayload) {
    return jsonPayload;
  }

  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = (line.match(labelPattern) ?? line.replace(imagePrefixPattern, "").match(labelPattern));
    if (!match) {
      continue;
    }

    const inlinePayload = cleanPayload(match[1]);
    if (inlinePayload) {
      return inlinePayload;
    }

    const followingPayload = nextPayloadLine(lines, index);
    if (followingPayload) {
      return followingPayload;
    }
  }

  for (const line of lines) {
    if (metadataLinePattern.test(line) || noResultPattern.test(line)) {
      continue;
    }
    return cleanPayload(line);
  }

  return null;
}

export const adapter = createOptionalCliDecodeAdapter({
  id: "zxing-cli",
  name: "ZXing CLI",
  commands: [
    {
      command: "ZXingReader",
      discoveryArgs: ["--help"],
      decodeArgs: (pngPath) => [pngPath]
    },
    {
      command: "zxing",
      discoveryArgs: ["--help"],
      decodeArgs: (pngPath) => [pngPath]
    },
    {
      command: "zxing-cpp",
      discoveryArgs: ["--help"],
      decodeArgs: (pngPath) => [pngPath]
    },
    {
      command: "zxingscan",
      discoveryArgs: ["--help"],
      decodeArgs: (pngPath) => [pngPath]
    }
  ],
  parseOutput: parseZxingOutput,
  rawBinaryReason: "ZXing CLI output formats vary by command; this adapter does not treat CLI output as reliable raw bytes."
});

export default adapter;
