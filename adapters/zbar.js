import { createOptionalCliDecodeAdapter } from "./cli-decoder.js";

export function parseZbarOutput(stdout) {
  const text = String(stdout ?? "").replaceAll("\r\n", "\n").replace(/\n+$/u, "");
  return text.length > 0 ? text : null;
}

export const adapter = createOptionalCliDecodeAdapter({
  id: "zbarimg",
  name: "zbarimg",
  commands: [{
    command: "zbarimg",
    discoveryArgs: ["--version"],
    decodeArgs: (pngPath) => ["--quiet", "--raw", pngPath]
  }],
  parseOutput: parseZbarOutput,
  rawBinaryReason: "zbarimg --raw exposes decoded text, but this adapter does not treat it as reliable raw bytes."
});

export default adapter;
