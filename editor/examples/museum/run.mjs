import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgent, createRuntimeServices } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import {
  createRetrievalWorker,
  createTextSearchProvider,
  RetrievalTargetRegistry,
} from "@codesoul-co/ditto-retrieval";
import { openAgentStorage } from "../../../examples/_shared/tools/storage/workers.ts";
import { answerFiles } from "../../../examples/_shared/tools/package-basics.ts";

const { values } = parseArgs({ options: { definition: { type: "string" } } });
const definition = JSON.parse(
  await readFile(values.definition ?? new URL("./agent.json", import.meta.url), "utf8"),
);
const venue = JSON.parse(await readFile(new URL("./venue.json", import.meta.url), "utf8"));
const services = createRuntimeServices({});
const model = services.config.model;
if (!model) throw new Error("Configure an inference provider and model in the project configuration.");
const directory = await mkdtemp(join(tmpdir(), "ditto-museum-"));
const sessionId = randomUUID();
const cases = venue.visitors.map(({ id, ...visitor }) => ({
  ...visitor,
  key: id,
  queueId: id + "-review",
  scratchKey: "scratch:" + id,
  scope: { sessionId, turnId: id },
}));
const guide = createTextSearchProvider({
  async search({ query, target, limit }) {
    const term = query.content.toLowerCase();
    const candidates = venue.guide
      .filter((page) => page.content.toLowerCase().includes(term))
      .slice(0, limit);
    return { target, candidates };
  },
});
const ticketQuote = {
  name: "ticket_quote",
  effects: [],
  requiresApproval: false,
  inputSchema: {
    type: "object",
    properties: { adults: { type: "integer" }, children: { type: "integer" } },
    required: ["adults", "children"],
  },
  validate({ adults, children }) {
    if (![adults, children].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100))
      throw new Error("Group counts must be integers from 0 to 100");
  },
  async execute({ adults, children }) {
    const total = adults * venue.prices.adult + children * venue.prices.child;
    return {
      status: "success",
      content: `Ticket desk quote: USD ${total} for ${adults} adults and ${children} children.`,
    };
  },
};
const server = new McpServer({ name: "front-desk", version: "1.0.0" });
server.registerTool(
  "daily_notice",
  { description: "Read the museum's current visitor bulletin" },
  async () => ({ content: [{ type: "text", text: venue.notice }] }),
);
const client = new Client({ name: "visitor-desk", version: "1.0.0" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const storage = await openAgentStorage(directory, services.config);
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const agent = await createAgent(definition, {
    config: services.config,
    sandbox: { tools: ["ticket_quote"], mcp: ["front-desk"] },
    workers: {
      context: storage.workers[0],
      memory: storage.workers[1],
      infer: createInferWorker({ providers: services.providers }),
      retrieval: createRetrievalWorker({
        providers: new RetrievalTargetRegistry({
          "museum-guide": { defaultStrategy: "keyword", providers: { keyword: guide } },
        }),
      }),
      interaction: createInteractionWorker({
        tools: [ticketQuote],
        mcp: {
          "front-desk": {
            listTools: (params, options) => client.listTools(params, options),
            callTool: (params, options) => client.callTool(params, undefined, options),
          },
        },
        output: answerFiles(join(directory, "answers")),
      }),
    },
  });
  try {
    const results = await agent.run({ cases, model }, { signal: AbortSignal.timeout(360_000) });
    console.log(
      JSON.stringify({ directory, results, remainingCount: cases.length - results.length }, null, 2),
    );
  } finally {
    await agent.close();
  }
} finally {
  try {
    await client.close();
  } finally {
    try {
      await server.close();
    } finally {
      await storage.close();
    }
  }
}
