import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import YAML from "yaml";

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(
    typeof value === "string" ? value : stableJson(value),
    "utf8",
  ).digest("hex");
}

export function readDocument(filePath, label) {
  const path = resolve(filePath);
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  let value;
  try {
    const text = readFileSync(path, "utf8");
    value = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : YAML.parse(text);
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return { path, value };
}

export function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    if (!existsSync(path) || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    rmSync(path, { force: true });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return path;
}

export function assertMapping(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value;
}

export function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key: ${key}`);
  }
}

export function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function stringArray(value, label, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${label} must be an array with at least ${minimum} item${minimum === 1 ? "" : "s"}`);
  }
  const result = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}
