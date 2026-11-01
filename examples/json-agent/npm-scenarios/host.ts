import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgent, createRuntimeServices, loadRuntimeConfig, type LoopGraphEvent } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createRetrievalWorker, createTextSearchProvider, RetrievalTargetRegistry } from "@codesoul-co/ditto-retrieval";
import { openAgentStorage } from "../../_shared/tools/storage/workers.ts";
import { answerFiles } from "../../_shared/tools/package-basics.ts";

export interface ScenarioRequest {
  text: string; mode: "research" | "recall"; prompt: string; memoryKey: string; deliveryId: string;
  scope: { sessionId: string; turnId: string };
}
export function createTrace() {
  return { modelCalls: 0, searches: 0, tools: [] as { text: string; token: string }[], deliveries: 0, graphs: [] as LoopGraphEvent[] };
}

/** Only resource/implementation wiring lives here. All orchestration is in the selected agent.json. */
export async function runScenario(definition: unknown, request: ScenarioRequest, directory: string,
  textWorker: WorkerDefinition, trace = createTrace()) {
  if (!request || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.deliveryId) || typeof request.prompt !== "string") throw new Error("Invalid request");
  await mkdir(directory, { recursive: true });
  const config = loadRuntimeConfig(process.env, { runtime: { timeoutMs: 60_000 }, workers: { context: { cache: { ttlMs: 300_000 } } } });
  if (!config.model) throw new Error("Configure a real model for the npm scenarios");
  const services = createRuntimeServices({ config });
  const provider = services.providers.get(config.model.provider);
  const storage = await openAgentStorage(directory, config);
  try {
    const output = answerFiles(join(directory, "answers"));
    const retrieval = createTextSearchProvider({ async search(input) {
      trace.searches++;
      const documents: { id: string; content: string; source: { ref: string } }[] = JSON.parse(await readFile(join(directory, "guide.json"), "utf8"));
      const query = String(input.query.content).toLowerCase();
      return { target: input.target, candidates: documents.filter(d => d.content.toLowerCase().includes(query)).slice(0, input.limit ?? 5) };
    } });
    const agent = await createAgent(definition, { config, workers: {
      context: storage.workers[0]!, memory: storage.workers[1]!, text: textWorker,
      infer: createInferWorker({ providers: { [config.model.provider]: {
        async invoke(input, options) { trace.modelCalls++; return provider.invoke(input, options); },
      } } }),
      retrieval: createRetrievalWorker({ providers: new RetrievalTargetRegistry({ guide: { defaultStrategy: "keyword", providers: { keyword: retrieval } } }) }),
      interaction: createInteractionWorker({ tools: [{
        name: "count_characters", effects: [], requiresApproval: false,
        inputSchema: { type: "object", properties: { text: { type: "string" }, token: { type: "string" } }, required: ["text", "token"] },
        validate(args) {
          if (typeof args.text !== "string" || args.text.length > 10_000 || typeof args.token !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(args.token)) throw new Error("Invalid count arguments");
        },
        async execute(args) {
          const text = String(args.text), token = String(args.token), characters = [...text].length;
          trace.tools.push({ text, token });
          return { status: "success", content: JSON.stringify({ characters, token }), structuredContent: { characters, token } };
        },
      }], output: { async deliver(input, context) { trace.deliveries++; return output.deliver(input, context); } } }),
    }, serviceProfiles: {
      "count-only": createRuntimeServices({ config, sandbox: { tools: ["count_characters"] } }),
      "no-tools": createRuntimeServices({ config, sandbox: { tools: [] } }),
    } });
    try {
      return { result: await agent.run({ ...request, model: config.model }, {
        signal: AbortSignal.timeout(180_000), onGraph: event => trace.graphs.push(event),
      }), trace };
    } finally { await agent.close(); }
  } finally { await storage.close(); }
}
