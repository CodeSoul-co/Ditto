import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgent, createRuntimeServices, type LoopGraphEvent } from "@codesoul-co/ditto/runtime";
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

/** Application-owned resources, opened once and reused by local or remote Workers. */
export async function openScenarioResources(directory: string, textWorker?: WorkerDefinition, trace = createTrace()) {
  await mkdir(directory, { recursive: true });
  const services = createRuntimeServices({});
  const config = services.config;
  if (!config.model) throw new Error("Configure a real model for the npm scenarios");
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
    return { config, model: config.model, trace, workers: {
      context: storage.workers[0]!, memory: storage.workers[1]!, ...(textWorker ? { text: textWorker } : {}),
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
    }, close: () => storage.close() };
  } catch (error) { await storage.close(); throw error; }
}

export function validateScenarioRequest(request: ScenarioRequest): void {
  if (!request || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.deliveryId) || typeof request.prompt !== "string") throw new Error("Invalid request");
}

/** agent.json owns orchestration; the host owns resources and request identity. */
export async function runScenario(definition: unknown, request: ScenarioRequest, directory: string,
  textWorker?: WorkerDefinition, trace = createTrace()) {
  validateScenarioRequest(request);
  const resources = await openScenarioResources(directory, textWorker, trace);
  try {
    const agent = await createAgent(definition, {
      config: resources.config, workers: resources.workers, serviceProfiles: resources.serviceProfiles,
    });
    try {
      return { result: await agent.run({ ...request, model: resources.model }, {
        signal: AbortSignal.timeout(180_000), onGraph: event => trace.graphs.push(event),
      }), trace };
    } finally { await agent.close(); }
  } finally { await resources.close(); }
}
