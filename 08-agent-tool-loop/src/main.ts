/**
 * Entry point: run the experiment over the committed dataset and print the
 * policy comparison, the flaw pricing, and the stubborn-model burn.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeCachingReport } from "./caching.js";
import { runDriftStudy } from "./driftStudy.js";
import { runExperiment } from "./experiment.js";
import { loadResultTasks, runResultStudy } from "./resultStudy.js";
import { loadCities, loadNotes, loadTasks } from "./tasks.js";
import { renderCachingReport, renderDriftReport, renderReport, renderResultReport } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dataDir = join(here, "..", "data");
  const tasks = loadTasks(join(dataDir, "tasks.json"));
  const cities = loadCities(join(dataDir, "cities.json"));
  const notes = loadNotes(join(dataDir, "notes.json"));
  const report = await runExperiment({ tasks, cities, notes });
  console.log(renderReport(report));
  console.log("");
  console.log(renderCachingReport(computeCachingReport(report, tasks)));
  console.log("");
  const driftReport = await runDriftStudy({
    tasks: loadTasks(join(dataDir, "driftTasks.json")),
    originalTasks: tasks,
    cities,
    notes,
  });
  console.log(renderDriftReport(driftReport));
  console.log("");
  const resultReport = await runResultStudy({
    tasks: loadResultTasks(join(dataDir, "resultTasks.json")),
    cities,
    notes,
  });
  console.log(renderResultReport(resultReport));
}

await main();
