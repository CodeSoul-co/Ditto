import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ContextSource, MemoryItem, Message, NodeContract } from "@codesoul-co/ditto/contracts";
import { createAgent, loadRuntimeConfig, type RuntimeConfig } from "@codesoul-co/ditto/runtime";
import { defineWorker } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../_shared/tools/storage/workers.ts";
import { answerFiles } from "../_shared/tools/package-basics.ts";

interface Request { session: string; turn: string; prompt: string }
interface TextMessage { role: "user" | "assistant"; content: string }
interface Conversation { turn: string; prompt: string; answer: string; messages: TextMessage[] }
interface Prepared { replayed: boolean; existingId: string | null; answer: string | null; history: TextMessage[]; sources: ContextSource[] }
declare module "@codesoul-co/ditto/contracts" {
  interface NodeContractMap {
    "EXAMPLE.JSON.CONVERSATION.PREPARE": NodeContract<{ request: Request; memories: MemoryItem[] }, Prepared>;
    "EXAMPLE.JSON.CONVERSATION.FINALIZE": NodeContract<{ request: Request; history: TextMessage[]; message: Message }, Conversation>;
  }
}
function validateRequest(request: Request): void {
  if (!request || ![request.session, request.turn].every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id))
    || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 8000) throw new Error("Invalid session, turn or prompt");
}
function messages(value: unknown): asserts value is TextMessage[] {
  if (!Array.isArray(value) || !value.every(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string"))
    throw new Error("Invalid stored messages");
}
const conversationWorker = () => defineWorker({ type: "conversation", nodes: {
  "EXAMPLE.JSON.CONVERSATION.PREPARE": async ({ request, memories }) => {
    validateRequest(request);
    if (!Array.isArray(memories)) throw new Error("Invalid stored memories");
    const existing = memories[0];
    let previous: Conversation | undefined;
    if (existing) {
      const value = existing.content as Partial<Conversation> | null;
      if (!value || typeof value.turn !== "string" || typeof value.prompt !== "string" || typeof value.answer !== "string") throw new Error("Invalid stored conversation");
      messages(value.messages); previous = value as Conversation;
    }
    const replayed = previous?.turn === request.turn;
    if (replayed && previous!.prompt !== request.prompt) throw new Error("A turn ID cannot be reused with a different prompt");
    const history = previous?.messages.slice(-10) ?? [];
    return { replayed, existingId: existing?.id ?? null, answer: replayed ? previous!.answer : null, history,
      sources: [
        ...history.map((m, i) => ({ id: `history-${i}`, content: m.content, metadata: { role: m.role, sourceType: "message" } })),
        { id: "current-user", content: request.prompt, metadata: { role: "user", currentGoal: true } },
      ],
    };
  },
  "EXAMPLE.JSON.CONVERSATION.FINALIZE": async ({ request, history, message }) => {
    validateRequest(request); messages(history);
    if (!message || message.role !== "assistant" || typeof message.content !== "string" || !message.content.trim()) throw new Error("Model returned no text answer");
    return { turn: request.turn, prompt: request.prompt, answer: message.content,
      messages: [...history, { role: "user", content: request.prompt }, { role: "assistant", content: message.content }],
    };
  },
} });

/** Host supplies identity and real resources; agent.json owns all Graphs, routing and deployment bindings. */
export async function runConversation(request: Request, directory: string, config: RuntimeConfig) {
  validateRequest(request);
  if (!config.model) throw new Error("Configure a model provider and default model");
  const dir = resolve(directory, request.session);
  await mkdir(dir, { recursive: true });
  const definition: unknown = JSON.parse(await readFile(new URL("conversation/agent.json", import.meta.url), "utf8"));
  const storage = await openAgentStorage(dir, config);
  try {
    const agent = await createAgent(definition, { config, workers: {
      context: storage.workers[0]!, memory: storage.workers[1]!, infer: createInferWorker(),
      interaction: createInteractionWorker({ output: answerFiles(join(dir, "answers")) }), conversation: conversationWorker(),
    } });
    try {
      const output = await agent.run({ ...request, model: config.model, memoryKey: `json-agent:${request.session}:conversation`,
        scope: { sessionId: `json-agent:${request.session}`, turnId: request.turn },
      }, { signal: AbortSignal.timeout(120_000) });
      if (!output || typeof output !== "object" || !("answer" in output) || typeof output.answer !== "string"
        || !("replayed" in output) || typeof output.replayed !== "boolean") throw new Error("Invalid Agent result");
      return { answer: output.answer, replayed: output.replayed, file: join(dir, "answers", `${request.turn}.md`) };
    } finally { await agent.close(); }
  } finally { await storage.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    session: { type: "string", default: "demo" }, turn: { type: "string" }, prompt: { type: "string" },
    directory: { type: "string", default: ".examples-json-agent-tasks" },
  } });
  if (!values.turn || !values.prompt) throw new Error("Pass --turn and --prompt");
  console.log(JSON.stringify(await runConversation({ session: values.session!, turn: values.turn, prompt: values.prompt }, values.directory!,
    loadRuntimeConfig(process.env, { runtime: { timeoutMs: 60_000 }, workers: { context: { cache: { ttlMs: 300_000 } } } })), null, 2));
}
