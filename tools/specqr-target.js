import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const specqrTargetRoot = process.env.SPECQR_CONFORMANCE_PACKAGE_ROOT
  ? path.resolve(process.env.SPECQR_CONFORMANCE_PACKAGE_ROOT)
  : null;

function selectImportTarget(exportsEntry, subpath) {
  if (typeof exportsEntry === "string") {
    return exportsEntry;
  }

  if (!exportsEntry || typeof exportsEntry !== "object" || Array.isArray(exportsEntry)) {
    throw new Error(`Published specqr export ${subpath} has no import target`);
  }

  const target = exportsEntry.import ?? exportsEntry.default;
  if (typeof target !== "string") {
    throw new Error(`Published specqr export ${subpath} has no import target`);
  }
  return target;
}

export async function readSpecqrPackageMetadata() {
  const packageJsonPath = specqrTargetRoot
    ? path.join(specqrTargetRoot, "package.json")
    : path.join(process.cwd(), "node_modules", "specqr", "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.name !== "specqr" || typeof packageJson.version !== "string") {
    throw new Error(`Invalid published specqr package metadata at ${packageJsonPath}`);
  }
  return packageJson;
}

async function importTarget(subpath) {
  if (!specqrTargetRoot) {
    return import(subpath === "." ? "specqr" : `specqr/${subpath.slice(2)}`);
  }

  const packageJson = await readSpecqrPackageMetadata();
  const exportsEntry = packageJson.exports?.[subpath];
  const relativeTarget = selectImportTarget(exportsEntry, subpath);
  const absoluteTarget = path.resolve(specqrTargetRoot, relativeTarget);
  if (!absoluteTarget.startsWith(`${specqrTargetRoot}${path.sep}`)) {
    throw new Error(`Published specqr export ${subpath} escapes the package root`);
  }
  return import(pathToFileURL(absoluteTarget).href);
}

export const specqrRoot = await importTarget(".");
export const specqrBrowser = await importTarget("./browser");
export const specqrNode = await importTarget("./node");

export const {
  analyzeSegments,
  createGs1DigitalLink,
  createGs1ElementString,
  estimate,
  generate,
  generateSegments,
  generateSegmentsStructuredAppend,
  generateStructuredAppend,
  getCapacity,
  mergeStructuredAppendParts,
  normalizeGs1DigitalLink,
  validateGs1DigitalLink,
  validateGs1ElementString
} = specqrRoot;
