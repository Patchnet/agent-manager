# Testing

Run the canonical local test gate from the repository root:

```sh
npm test
```

The suite uses the Node.js test runner and covers unit, integration, and
detached workflow behavior. Tests live in `test/`; temporary repositories and
run directories are created outside the source tree and removed after use.

CI runs the same suite on Windows and Linux. It also runs the public hygiene
scanner and an npm package dry run.

Quality exemptions are recorded in
[`quality-exemptions.md`](quality-exemptions.md). There are currently no active
exemptions.
