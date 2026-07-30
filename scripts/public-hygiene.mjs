import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const forbiddenFiles = files.filter((file) => /(^|\/)(?:CLAUDE|AGENTS)\.local\.md$|(^|\/)\.env(?:\.|$)/i.test(file));
const patterns = [
  { label: "machine-specific development path", regex: /[A-Za-z]:[\\/]dev[\\/]/i },
  { label: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "internal planning document id", regex: /(?:proj-|prj_)[a-z0-9_-]{8,}/i },
  { label: "organization email", regex: /[A-Z0-9._%+-]+@patchnet\.ai/i },
];
const findings = forbiddenFiles.map((file) => `${file}: forbidden local-only filename`);
for (const file of files) {
  if (file === "scripts/public-hygiene.mjs") continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const pattern of patterns) if (pattern.regex.test(text)) findings.push(`${file}: ${pattern.label}`);
}
if (findings.length) {
  console.error("Public hygiene check failed:\n" + findings.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Public hygiene check passed (${files.length} publishable files).`);
}
