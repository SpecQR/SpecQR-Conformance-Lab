import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function sanitized(value, replacements) {
  let text = String(value ?? "");
  for (const [from, to] of replacements) {
    text = text.replaceAll(from, to);
  }
  return text.trim();
}

export async function runV3TypescriptConsumers(packageRoot, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const installRoot = path.dirname(path.dirname(packageRoot));
  const source = path.join(cwd, "fixtures", "rc-v3-consumer");
  const target = path.join(installRoot, ".specqr-v3-consumer");
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });

  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  const replacements = [[installRoot, "[temporary-install]"], [cwd, "."]];
  return ["literal", "dynamic"].map((name) => {
    const project = path.join(target, `tsconfig.${name}.json`);
    const run = spawnSync(process.execPath, [tsc, "-p", project, "--noEmit"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    return {
      id: `typescript-${name}`,
      status: run.status === 0 ? "passed" : "failed",
      project: `fixtures/rc-v3-consumer/tsconfig.${name}.json`,
      exitCode: run.status,
      signal: run.signal ?? null,
      stdout: sanitized(run.stdout, replacements),
      stderr: sanitized(run.stderr, replacements)
    };
  });
}
