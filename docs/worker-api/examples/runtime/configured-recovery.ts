import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgent, createInteractionWorker, loadRuntimeConfig, AgentPausedError,
  type AgentCheckpoint,
} from "@codesoul-co/ditto";

/** Control-plane example: deterministic tools, three Graphs, and a host-owned file checkpoint. */
export function recoveryWorker(onCall: () => void = () => {}) {
  return createInteractionWorker({ tools: [{ name: "echo", inputSchema: { type: "object" }, effects: [],
    validate(args) { if (typeof args.value !== "string") throw new Error("value must be a string"); },
    async execute(args) { onCall(); return { status: "success", content: args.value as string }; },
  }] });
}

/** Single writer only. Production multi-host stores should enforce a lease or compare-and-swap. */
export async function runConfiguredRecovery(directory: string, pause = false) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "checkpoint.json");
  let resume: AgentCheckpoint | undefined;
  try { resume = JSON.parse(await readFile(path, "utf8")) as AgentCheckpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const definition: unknown = JSON.parse(await readFile(new URL("configured-recovery.agent.json", import.meta.url), "utf8"));
  let toolCalls = 0;
  const agent = await createAgent(definition, { config: loadRuntimeConfig({}), sandbox: { tools: ["echo"] },
    workers: { tools: recoveryWorker(() => { toolCalls++; }) },
  });
  try {
    const output = await agent.run("hello", { stateCheckpoint: { id: "example-1", version: "echo-v1",
      ...(resume ? { resume } : {}),
      async save(checkpoint) {
        const file = await open(`${path}.tmp`, "w", 0o600);
        try { await file.writeFile(JSON.stringify(checkpoint)); await file.sync(); }
        finally { await file.close(); }
        await rename(`${path}.tmp`, path);
        const folder = await open(directory, "r");
        try { await folder.sync(); } finally { await folder.close(); }
      },
    }, onBoundary: boundary => pause && boundary.iteration === 1 ? { update: { value: "host message" }, pause: true } : undefined });
    return { paused: false, output, toolCalls };
  } catch (error) {
    if (error instanceof AgentPausedError) return { paused: true, step: error.checkpoint.state.step, toolCalls };
    throw error;
  } finally { await agent.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await runConfiguredRecovery(process.argv[2] ?? ".ditto-recovery", process.argv[3] === "pause")));
