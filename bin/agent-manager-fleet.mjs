#!/usr/bin/env node
import { fleetUsage, parseFleetArgs, runFleet } from "../src/fleet.mjs";

async function main() {
  const options = parseFleetArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fleetUsage());
    return;
  }
  await runFleet(options);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
