import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runScenario } from "./host.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [configuration, input, directory] = process.argv.slice(2);
  if (!configuration || !input || !directory) throw new Error("Usage: cli.mjs agent.json input.json task-directory");
  const definition = JSON.parse(await readFile(configuration, "utf8"));
  const request = JSON.parse(await readFile(input, "utf8"));
  const textWorker = definition.deployment?.workers?.some(worker => worker.use === "text")
    ? (await import("@ditto-example/text-worker")).createTextWorker() : undefined;
  console.log(JSON.stringify(await runScenario(definition, request, directory, textWorker)));
}
