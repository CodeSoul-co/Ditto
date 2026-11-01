import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createAgent } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";

/** Local LOAD -> SELECT; an explicit path can also run the standard Graph/Subgraph/Loop template. */
export async function quickstart(text = "Hello Ditto", configuration: string | URL = new URL("agent.json", import.meta.url)) {
  const definition: unknown = JSON.parse(await readFile(configuration, "utf8"));
  const agent = await createAgent(definition, { workers: { context: createContextWorker() } });
  try { return await agent.run(text); }
  finally { await agent.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await quickstart(process.argv[2], process.argv[3]));
