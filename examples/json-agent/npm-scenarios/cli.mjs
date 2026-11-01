import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createTextWorker } from "@ditto-example/text-worker";
import { runScenario } from "./host.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [configuration, input, directory] = process.argv.slice(2);
  if (!configuration || !input || !directory) throw new Error("Usage: cli.mjs agent.json input.json task-directory");
  const definition = JSON.parse(await readFile(configuration, "utf8"));
  const request = JSON.parse(await readFile(input, "utf8"));
  console.log(JSON.stringify(await runScenario(definition, request, directory, createTextWorker())));
}
