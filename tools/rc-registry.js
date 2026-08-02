import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  rcExpandedSha256,
  rcPublishedAt,
  rcTarballSha256,
  rcVersion
} from "./rc-constants.js";
import { createCheck, deepEqual, sha256, stableStringify, statusCounts } from "./rc-utils.js";

function commandText(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function runCommand(command, args, options = {}) {
  const run = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  const record = [
    `$ ${commandText(command, args)}`,
    run.stdout?.trimEnd(),
    run.stderr?.trimEnd()
  ].filter(Boolean).join("\n");
  options.logs?.push(record);

  if (run.status !== 0) {
    throw new Error(`${command} exited with ${run.status}: ${run.stderr || run.stdout}`.trim());
  }
  return run.stdout;
}

function fetchBuffer(url, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many registry redirects for ${url}`);
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        accept: "application/octet-stream",
        "user-agent": "SpecQR-Conformance-Lab"
      }
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(fetchBuffer(new URL(response.headers.location, url).href, redirects + 1));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Registry request failed with HTTP ${statusCode}: ${url}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function tarString(block, start, length) {
  return block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "").trim();
}

function tarNumber(block, start, length) {
  const value = tarString(block, start, length);
  return value ? Number.parseInt(value, 8) : 0;
}

function tarChecksum(block) {
  let checksum = 0;
  for (let index = 0; index < block.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 32 : block[index];
  }
  return checksum;
}

function parsePax(data) {
  const result = {};
  let offset = 0;
  const text = data.toString("utf8");
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) {
      throw new Error("Invalid PAX record length");
    }
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isInteger(length) || length <= 0) {
      throw new Error("Invalid PAX record");
    }
    const record = text.slice(space + 1, offset + length - 1);
    const separator = record.indexOf("=");
    if (separator !== -1) {
      result[record.slice(0, separator)] = record.slice(separator + 1);
    }
    offset += length;
  }
  return result;
}

export function archiveManifest(tarball) {
  const tar = gunzipSync(tarball);
  const files = [];
  const seen = new Set();
  let offset = 0;
  let nextPax = {};
  let globalPax = {};
  let longPath = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const expectedChecksum = tarNumber(header, 148, 8);
    if (expectedChecksum !== tarChecksum(header)) {
      throw new Error("Registry tarball contains an invalid tar header checksum");
    }

    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0);
    const rawName = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${rawName}` : rawName;
    const body = tar.subarray(offset, offset + size);
    if (body.length !== size) {
      throw new Error("Registry tarball ended before a file body was complete");
    }
    offset += Math.ceil(size / 512) * 512;

    if (type === "x") {
      nextPax = parsePax(body);
      continue;
    }
    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(body) };
      continue;
    }
    if (type === "L") {
      longPath = body.toString("utf8").replace(/\0.*$/s, "").trim();
      continue;
    }

    const metadata = { ...globalPax, ...nextPax };
    nextPax = {};
    const archivePath = metadata.path ?? longPath ?? headerPath;
    longPath = null;
    if (!["\0", "0", "7"].includes(type)) {
      continue;
    }
    if (!archivePath.startsWith("package/")) {
      throw new Error(`Registry tarball file is outside package/: ${archivePath}`);
    }

    const relativePath = archivePath.slice("package/".length);
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      throw new Error(`Registry tarball has an unsafe path: ${archivePath}`);
    }
    if (seen.has(relativePath)) {
      throw new Error(`Registry tarball repeats a file path: ${relativePath}`);
    }
    seen.add(relativePath);
    files.push({
      path: relativePath,
      size,
      sha256: sha256(body)
    });
  }

  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function expandedManifestSha256(manifest) {
  return sha256(`${JSON.stringify(manifest)}\n`);
}

async function installedManifest(packageRoot) {
  const files = [];

  async function walk(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Installed package contains a symbolic link: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (stats.isFile()) {
        const contents = await readFile(absolutePath);
        files.push({ path: relativePath, size: contents.length, sha256: sha256(contents) });
      } else {
        throw new Error(`Installed package contains an unsupported entry: ${relativePath}`);
      }
    }
  }

  await walk(packageRoot);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function selectImportTarget(exportsEntry, label) {
  if (typeof exportsEntry === "string") {
    return exportsEntry;
  }
  const target = exportsEntry?.import ?? exportsEntry?.default;
  if (typeof target !== "string") {
    throw new Error(`Published package export ${label} has no import target`);
  }
  return target;
}

async function importPackageExport(packageRoot, packageJson, subpath) {
  const relativePath = selectImportTarget(packageJson.exports?.[subpath], subpath);
  const absolutePath = path.resolve(packageRoot, relativePath);
  if (!absolutePath.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(`Published package export ${subpath} escapes the package root`);
  }
  return import(`${pathToFileURL(absolutePath).href}?integrity=${Date.now()}-${Math.random()}`);
}

function exportTypes(moduleNamespace) {
  return Object.fromEntries(
    Object.keys(moduleNamespace).sort().map((name) => [name, typeof moduleNamespace[name]])
  );
}

function matrixSha256(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new Error("Representative root runtime did not return a matrix");
  }
  const rows = matrix.map((row) => row.map((module) => module ? "1" : "0").join("")).join("\n");
  return sha256(rows);
}

async function runtimeSurface(packageRoot, packageJson) {
  const root = await importPackageExport(packageRoot, packageJson, ".");
  const node = await importPackageExport(packageRoot, packageJson, "./node");
  const browser = await importPackageExport(packageRoot, packageJson, "./browser");
  const input = "SPECQR RC BLACK BOX";
  const matrix = root.generate(input, {
    version: 2,
    errorCorrectionLevel: "M",
    maskPattern: 0,
    output: "matrix",
    diagnostics: false
  });
  const png = node.toPngBuffer(input, { version: 2, errorCorrectionLevel: "M", maskPattern: 0 });

  return {
    exports: {
      root: exportTypes(root),
      node: exportTypes(node),
      browser: exportTypes(browser)
    },
    smoke: {
      root: {
        matrixSize: matrix.length,
        matrixSha256: matrixSha256(matrix)
      },
      node: {
        isBuffer: Buffer.isBuffer(png),
        byteLength: png.length,
        pngSignature: Array.from(png.subarray(0, 8)),
        sha256: sha256(png)
      },
      browser: {
        helperTypes: Object.fromEntries([
          "toBlob",
          "toBlobFromSegments",
          "toImageData",
          "toImageDataFromSegments",
          "toObjectURL",
          "toObjectURLFromSegments"
        ].map((name) => [name, typeof browser[name]]))
      }
    }
  };
}

function packageMetadataSubset(packageJson) {
  return {
    name: packageJson.name,
    version: packageJson.version,
    type: packageJson.type,
    main: packageJson.main,
    types: packageJson.types,
    exports: packageJson.exports,
    engines: packageJson.engines,
    sideEffects: packageJson.sideEffects ?? null,
    runtimeDependencies: packageJson.dependencies ?? {}
  };
}

function registryMetadataSubset(view) {
  return {
    name: view.name,
    version: view.version,
    type: view.type,
    main: view.main,
    types: view.types,
    exports: view.exports,
    engines: view.engines,
    sideEffects: view.sideEffects ?? null,
    runtimeDependencies: view.dependencies ?? {}
  };
}

function publicationSecond(value) {
  return typeof value === "string" ? `${value.slice(0, 19)}Z` : null;
}

export async function installAndVerifyRegistryTarget(packageSpec, options = {}) {
  if (!/^specqr@(?:3\.0\.0-rc\.1|next)$/.test(packageSpec)) {
    throw new Error(`RC registry verifier does not allow target ${packageSpec}`);
  }

  const installation = await installRegistryPackage(packageSpec, options);
  const { installRoot, packageRoot, logs } = installation;

  const view = JSON.parse(runCommand("npm", [
    "view",
    packageSpec,
    "name",
    "version",
    "dist.tarball",
    "dist.integrity",
    "dist.shasum",
    "type",
    "main",
    "types",
    "exports",
    "engines",
    "sideEffects",
    "dependencies",
    "--json"
  ], { logs }));
  const time = JSON.parse(runCommand("npm", ["view", "specqr", "time", "--json"], { logs }));

  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const tarball = await fetchBuffer(view["dist.tarball"]);
  logs.push(`Fetched ${view["dist.tarball"]} (${tarball.length} bytes) directly from the npm registry.`);
  const packedManifest = archiveManifest(tarball);
  const unpackedManifest = await installedManifest(packageRoot);
  const tarballSha256 = sha256(tarball);
  const expandedSha256 = expandedManifestSha256(packedManifest);
  const tarballSha512 = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const tarballSha1 = createHash("sha1").update(tarball).digest("hex");
  const runtime = await runtimeSurface(packageRoot, packageJson);
  const packageMetadata = packageMetadataSubset(packageJson);
  const registryMetadata = registryMetadataSubset(view);
  const checks = [
    createCheck("resolved-version", packageJson.version === rcVersion && view.version === rcVersion, {
      expected: rcVersion,
      installed: packageJson.version,
      registry: view.version
    }),
    createCheck("publication-time", publicationSecond(time[rcVersion]) === rcPublishedAt, {
      expected: rcPublishedAt,
      actual: time[rcVersion] ?? null
    }),
    createCheck("tarball-sha256", tarballSha256 === rcTarballSha256, {
      expected: rcTarballSha256,
      actual: tarballSha256
    }),
    createCheck("expanded-sha256", expandedSha256 === rcExpandedSha256, {
      expected: rcExpandedSha256,
      actual: expandedSha256
    }),
    createCheck("registry-integrity", tarballSha512 === view["dist.integrity"], {
      expected: view["dist.integrity"],
      actual: tarballSha512
    }),
    createCheck("registry-shasum", tarballSha1 === view["dist.shasum"], {
      expected: view["dist.shasum"],
      actual: tarballSha1
    }),
    createCheck("installed-manifest", deepEqual(packedManifest, unpackedManifest), {
      packedFileCount: packedManifest.length,
      installedFileCount: unpackedManifest.length
    }),
    createCheck("registry-package-metadata", deepEqual(registryMetadata, packageMetadata), {
      registry: registryMetadata,
      installed: packageMetadata
    }),
    createCheck("runtime-dependencies-zero", Object.keys(packageJson.dependencies ?? {}).length === 0, {
      actual: Object.keys(packageJson.dependencies ?? {}).length
    }),
    createCheck("root-export", runtime.exports.root.generate === "function" && runtime.exports.root.QRCode === "function"),
    createCheck(
      "node-export",
      runtime.smoke.node.isBuffer === true && runtime.smoke.node.pngSignature.join(",") === "137,80,78,71,13,10,26,10",
      runtime.smoke.node
    ),
    createCheck("browser-export", Object.values(runtime.smoke.browser.helperTypes).every((type) => type === "function"), runtime.smoke.browser)
  ];
  const counts = statusCounts(checks);
  const evidence = {
    schemaVersion: 1,
    kind: "specqr-registry-integrity",
    requested: packageSpec,
    source: "npm-registry",
    resolvedVersion: packageJson.version,
    publication: {
      expected: rcPublishedAt,
      registry: time[rcVersion]
    },
    dist: {
      tarball: view["dist.tarball"],
      integrity: view["dist.integrity"],
      shasum: view["dist.shasum"]
    },
    hashes: {
      tarballSha256,
      expandedSha256,
      manifestSha256: sha256(`${stableStringify(packedManifest)}\n`)
    },
    packageMetadata,
    registryMetadata,
    runtimeDependencyCount: Object.keys(packageJson.dependencies ?? {}).length,
    manifest: packedManifest,
    runtime,
    checks,
    summary: counts,
    status: counts.failed === 0 ? "pass" : "blocked"
  };

  return {
    installRoot,
    packageRoot,
    evidence,
    log: logs.join("\n\n")
  };
}

export async function installRegistryPackage(packageSpec, options = {}) {
  if (!/^specqr@(?:2\.4\.0|3\.0\.0-rc\.1|next)$/.test(packageSpec)) {
    throw new Error(`Registry installer does not allow target ${packageSpec}`);
  }
  const logs = [];
  const parentRoot = options.parentRoot ?? tmpdir();
  await mkdir(parentRoot, { recursive: true });
  const installRoot = await mkdtemp(path.join(parentRoot, "specqr-registry-"));
  await writeFile(path.join(installRoot, "package.json"), `${JSON.stringify({ private: true })}\n`, "utf8");
  runCommand("npm", [
    "install",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--no-save",
    packageSpec
  ], { logs });
  return {
    installRoot,
    packageRoot: path.join(installRoot, "node_modules", "specqr"),
    logs
  };
}

function comparableRegistryEvidence(evidence) {
  return {
    resolvedVersion: evidence.resolvedVersion,
    publication: evidence.publication,
    dist: evidence.dist,
    hashes: evidence.hashes,
    packageMetadata: evidence.packageMetadata,
    registryMetadata: evidence.registryMetadata,
    runtimeDependencyCount: evidence.runtimeDependencyCount,
    manifest: evidence.manifest,
    runtime: evidence.runtime,
    checkOutcomes: evidence.checks.map(({ id, status }) => ({ id, status }))
  };
}

export function compareRegistryEvidence(exact, next) {
  const exactComparable = comparableRegistryEvidence(exact);
  const nextComparable = comparableRegistryEvidence(next);
  const checks = [
    createCheck("exact-integrity-pass", exact.status === "pass"),
    createCheck("next-integrity-pass", next.status === "pass"),
    createCheck("selector-equivalence", deepEqual(exactComparable, nextComparable), {
      exactFingerprint: sha256(stableStringify(exactComparable)),
      nextFingerprint: sha256(stableStringify(nextComparable))
    })
  ];
  const counts = statusCounts(checks);
  return {
    schemaVersion: 1,
    kind: "specqr-registry-selector-comparison",
    exact: exact.requested,
    next: next.requested,
    resolvedVersion: exact.resolvedVersion,
    checks,
    summary: counts,
    status: counts.failed === 0 ? "pass" : "blocked"
  };
}
