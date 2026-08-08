import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./util.mjs";

export class DirectorLeaseError extends Error {
  constructor(repoRoot, leasePath, holder = null) {
    super(`Director repository lease is already held for ${repoRoot}: ${leasePath}`);
    this.name = "DirectorLeaseError";
    this.code = "DIRECTOR_REPOSITORY_LEASE_HELD";
    this.leasePath = leasePath;
    this.holder = holder;
  }
}

export function acquireRepositoryLease({ stateRoot, repoRoot, cycleId, now = () => new Date() }) {
  const leasesRoot = join(resolve(stateRoot), "leases");
  mkdirSync(leasesRoot, { recursive: true, mode: 0o700 });
  const canonicalRepository = resolve(repoRoot);
  const leasePath = join(leasesRoot, `${sha256(canonicalRepository).slice(0, 24)}.lock`);
  const acquiredAt = now().toISOString();
  const token = sha256(`${cycleId}\0${process.pid}\0${acquiredAt}`);
  const metadata = {
    schema: "agent-manager.director-lease.v1",
    cycleId,
    repository: canonicalRepository,
    pid: process.pid,
    acquiredAt,
    token,
  };
  let fd;
  try {
    fd = openSync(leasePath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
      rmSync(leasePath, { force: true });
    }
    if (error?.code !== "EEXIST") throw error;
    let holder = null;
    try { holder = JSON.parse(readFileSync(leasePath, "utf8")); } catch { /* fail closed */ }
    throw new DirectorLeaseError(canonicalRepository, leasePath, holder);
  }
  closeSync(fd);

  let released = false;
  return {
    path: leasePath,
    metadata,
    release() {
      if (released) return false;
      let current;
      try { current = JSON.parse(readFileSync(leasePath, "utf8")); } catch { return false; }
      if (current.token !== token) return false;
      rmSync(leasePath, { force: true });
      released = true;
      return true;
    },
  };
}
