import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

async function markdownFiles(cwd) {
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "adapters/README.md"];
  for (const entry of await readdir(path.join(cwd, "docs"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.join("docs", entry.name));
    }
  }
  return files.sort();
}

function localTargets(source) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match = pattern.exec(source);
  while (match) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (target.includes(" \"")) {
      target = target.slice(0, target.indexOf(" \"") + 1).trim();
    }
    if (target && !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      targets.push(decodeURIComponent(target.split("#")[0]));
    }
    match = pattern.exec(source);
  }
  return targets;
}

export async function verifyLinks(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const errors = [];
  let checked = 0;
  for (const file of await markdownFiles(cwd)) {
    const source = await readFile(path.join(cwd, file), "utf8");
    for (const target of localTargets(source)) {
      checked += 1;
      const resolved = path.resolve(cwd, path.dirname(file), target);
      try {
        await access(resolved);
      } catch {
        errors.push({ file, target });
      }
    }
  }
  return { ok: errors.length === 0, checked, errors };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await verifyLinks();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
