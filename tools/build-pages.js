import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { badgeFileNames } from "./report-utils.js";

export async function buildPages(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const publicDir = options.publicDir ?? path.join(cwd, "public");
  const reportsDir = path.join(cwd, "reports");
  const badgesDir = path.join(cwd, "badges");
  const schemasDir = path.join(cwd, "schemas");
  const publicReportsDir = path.join(publicDir, "reports");
  const publicBadgesDir = path.join(publicDir, "badges");
  const publicSchemasDir = path.join(publicDir, "schemas");

  await rm(publicDir, { recursive: true, force: true });
  await mkdir(publicReportsDir, { recursive: true });
  await mkdir(publicBadgesDir, { recursive: true });
  await mkdir(publicSchemasDir, { recursive: true });

  await copyFile(path.join(reportsDir, "latest.html"), path.join(publicDir, "index.html"));
  await copyFile(path.join(reportsDir, "latest.html"), path.join(publicReportsDir, "latest.html"));
  await copyFile(path.join(reportsDir, "latest.json"), path.join(publicReportsDir, "latest.json"));

  const badgeEntries = await readdir(badgesDir, { withFileTypes: true });
  const badgeFiles = badgeEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const missingBadges = badgeFileNames.filter((fileName) => !badgeFiles.includes(fileName));

  if (missingBadges.length > 0) {
    throw new Error(`missing required badge files: ${missingBadges.join(", ")}`);
  }

  const files = ["index.html", "reports/latest.html", "reports/latest.json"];
  for (const fileName of badgeFiles) {
    await copyFile(path.join(badgesDir, fileName), path.join(publicBadgesDir, fileName));
    files.push(`badges/${fileName}`);
  }

  const schemaEntries = await readdir(schemasDir, { withFileTypes: true });
  const schemaFiles = schemaEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map((entry) => entry.name)
    .sort();

  for (const fileName of schemaFiles) {
    await copyFile(path.join(schemasDir, fileName), path.join(publicSchemasDir, fileName));
    files.push(`schemas/${fileName}`);
  }

  return {
    ok: true,
    publicDir,
    files
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const result = await buildPages();
  console.log(JSON.stringify({
    ok: result.ok,
    publicDir: path.relative(process.cwd(), result.publicDir) || ".",
    files: result.files
  }, null, 2));
}
