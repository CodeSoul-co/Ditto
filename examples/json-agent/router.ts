import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { NodeContract } from "@codesoul-co/ditto/contracts";
import { createAgent, createRuntimeServices } from "@codesoul-co/ditto/runtime";
import { defineWorker } from "@codesoul-co/ditto/worker";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";

interface TextRequest { text: string; mode: "count" | "echo" }
declare module "@codesoul-co/ditto/contracts" {
  interface NodeContractMap {
    "EXAMPLE.JSON.TEXT.NORMALIZE": NodeContract<TextRequest, TextRequest>;
    "EXAMPLE.JSON.TEXT.ROUTE": NodeContract<TextRequest, TextRequest>;
  }
}
function validate(input: TextRequest): void {
  if (!input || typeof input.text !== "string" || input.text.length > 10_000 || !["count", "echo"].includes(input.mode))
    throw new Error("Expected bounded text and count/echo mode");
}

/** Exercises real custom handlers and a local tool; this is a compiler example, not a model Agent. */
export async function runRouter(text = "A😀", mode: "count" | "echo" = "count") {
  const definition: unknown = JSON.parse(await readFile(new URL("router/agent.json", import.meta.url), "utf8"));
  const agent = await createAgent(definition, {
    workers: {
      text: defineWorker({ type: "text", nodes: {
        "EXAMPLE.JSON.TEXT.NORMALIZE": async input => { validate(input); return { ...input, text: input.text.trim().normalize("NFC") }; },
        "EXAMPLE.JSON.TEXT.ROUTE": async input => { validate(input); return input; },
      } }),
      interaction: createInteractionWorker({ tools: [{
        name: "count_characters", effects: [], requiresApproval: false,
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        validate(args) { if (typeof args.text !== "string") throw new Error("text must be a string"); },
        async execute(args) { return { status: "success", structuredContent: { characters: [...String(args.text)].length } }; },
      }] }),
    },
    serviceProfiles: { "count-only": createRuntimeServices({ sandbox: { tools: ["count_characters"] } }) },
  });
  try { return await agent.run({ text, mode, callId: randomUUID() }); }
  finally { await agent.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[3] ?? "count";
  if (mode !== "count" && mode !== "echo") throw new Error("Use count or echo");
  console.log(JSON.stringify(await runRouter(process.argv[2], mode)));
}
