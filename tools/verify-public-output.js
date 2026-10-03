import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { badgeFileNames } from "./report-utils.js";
import { verifyReportObject } from "./verify-report.js";
import { verifyCoverageClaimsFile } from "./verify-coverage-claims.js";

export function publicTextProblems(text, options = {}) {
  const problems = [];
  if (/(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]|\/private\/var\/folders\/|\/var\/folders\/|\/tmp\/|\/private\/tmp\/)/u.test(text)) problems.push("absolute machine path");
  const roots = [options.cwd ?? process.cwd(), options.home ?? homedir()].filter((value) => value && value.length > 3);
  if (roots.some((value) => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)))) problems.push("current machine root");
  const env = options.env ?? process.env;
  for (const [key, value] of Object.entries(env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key) && typeof value === "string" && value.length >= 8 && text.includes(value)) {
      problems.push("credential value");
      break;
    }
  }
  return [...new Set(problems)];
}

export async function verifyPublicOutput(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const report = JSON.parse(await readFile(path.join(cwd, "reports/latest.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  const pinned = packageJson.devDependencies.specqr;
  const errors = [];
  if (report.run?.mode !== "full" || report.target?.resolvedVersion !== pinned || report.target?.requested !== `specqr@${pinned}`) {
    errors.push({file:"reports/latest.json", problem:"public output requires a full pinned-baseline report"});
  }
  const integrity = await verifyReportObject(report, {cwd});
  if (!integrity.ok) errors.push({file:"reports/latest.json",problem:"report integrity failed"});
  const claims = await verifyCoverageClaimsFile({cwd,report});
  if (!claims.ok) errors.push({file:"coverage/claims-v1.json",problem:"coverage evidence failed"});
  const files = ["reports/latest.json", "reports/latest.html", "coverage/claims-v1.json", ...badgeFileNames.map((name) => `badges/${name}`), "badges/conformance.json"];
  for (const file of files) {
    const problems = publicTextProblems(await readFile(path.join(cwd, file), "utf8"), {...options,cwd});
    for (const problem of problems) errors.push({file,problem});
  }
  return {ok:errors.length===0, checked:files.length, target:`specqr@${pinned}`, errors};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyPublicOutput();
    console.log(JSON.stringify(result,null,2));
    if (!result.ok) process.exitCode=1;
  } catch {
    console.error(JSON.stringify({ok:false,error:"Public output validation could not complete; regenerate all baseline artifacts."}));
    process.exitCode=1;
  }
}
