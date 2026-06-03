import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  defaultSpecqrPackageName,
  defaultSpecqrTargetSource,
  readInstalledPackageMetadata
} from "./report-metadata.js";

export async function verifySpecqrTarget(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const packageName = options.packageName ?? defaultSpecqrPackageName;
  const packageJson = await readInstalledPackageMetadata(packageName, { cwd });
  const requested = options.requested ?? env.SPECQR_TARGET_REQUESTED ?? `${packageName}@${packageJson.version}`;
  const source = options.source ?? env.SPECQR_TARGET_SOURCE ?? defaultSpecqrTargetSource;

  return {
    ok: true,
    target: {
      packageName,
      requested,
      resolvedVersion: packageJson.version,
      source
    }
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    console.log(JSON.stringify(await verifySpecqrTarget(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  }
}
