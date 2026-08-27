/**
 * Entry point: run the experiment over the committed dataset and print the
 * policy comparison, the flaw pricing, and the stubborn-model burn.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runExperiment } from "./experiment.js";
import { loadCities, loadNotes, loadTasks } from "./tasks.js";
import { renderReport } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dataDir = join(here, "..", "data");
  const report = await runExperiment({
    tasks: loadTasks(join(dataDir, "tasks.json")),
    cities: loadCities(join(dataDir, "cities.json")),
    notes: loadNotes(join(dataDir, "notes.json")),
  });
  console.log(renderReport(report));
}

await main();
