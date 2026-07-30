import { readFile } from "node:fs/promises";

const [versionDocument, packageDocument, lockDocument] = await Promise.all([
  readFile(new URL("../Version.md", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
]);

const versionMatch = versionDocument.match(/^current:\s*(\d+\.\d+\.\d+)\s*$/m);
if (!versionMatch) {
  throw new Error("Version.md does not contain a valid current version");
}

const expected = versionMatch[1];
const packageJson = JSON.parse(packageDocument);
const packageLock = JSON.parse(lockDocument);
const stamps = {
  "Version.md": expected,
  "package.json": packageJson.version,
  "package-lock.json": packageLock.version,
  "package-lock.json packages root": packageLock.packages?.[""]?.version,
};

for (const [name, value] of Object.entries(stamps)) {
  if (value !== expected) {
    throw new Error(`${name} is ${value ?? "missing"}; expected ${expected}`);
  }
}

const escaped = expected.replaceAll(".", "\\.");
if (!new RegExp(`^## ${escaped}(?:\\s|$)`, "m").test(versionDocument)) {
  throw new Error(`Version.md is missing a history entry for ${expected}`);
}

console.log(`Version stamp is consistent: ${expected}`);
