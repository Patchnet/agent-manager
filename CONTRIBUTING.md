# Contributing

1. Fork or branch from the current default branch.
2. Install Node.js 24 or later and run `npm ci`.
3. Keep changes scoped and add tests for behavior changes.
4. Run `npm test`, `npm run hygiene`, and `npm pack --dry-run`.
5. Open a pull request that explains the behavior, security impact, and verification.

Do not commit local operator files, run telemetry, credentials, private prompts, internal project identifiers, or machine-specific paths. See [Public repository hygiene](docs/PUBLIC-REPO-HYGIENE.md).

Security issues must follow [SECURITY.md](SECURITY.md), not the public issue tracker.
