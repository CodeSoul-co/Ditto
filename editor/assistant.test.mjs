import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAgent } from "@codesoul-co/ditto/runtime";
import { workers, makeNode } from "./catalog.js";
import { translator } from "./i18n.js";
import { discuss, conversationContext } from "./assistant.mjs";
import { blankDefinition, createCanvasHistory } from "./canvases.js";
import { assignLoopColors, rangeColor } from "./loop-colors.js";
import { checkDefinition } from "./draft.mjs";
import {
  appendNode,
  connectBinding,
  disconnect,
  graphEdges,
  pruneConditions,
  setCondition,
  INPUT,
  OUTPUT,
} from "./connections.js";
import { graphModel } from "./canvas.js";
import { insertCall, newSubgraph } from "./structure.js";

const definition = {
  version: 1,
  id: "example",
  graphs: { main: { nodes: [{ id: "load", type: "CONTEXT.LOAD", input: { sources: [] } }] } },
};
test("new nodes leave existing boundary bindings intact and allow explicit connections", () => {
  const graph = { nodes: [] };
  const option = workers[0].nodes[0];
  const first = makeNode(option, graph.nodes);
  appendNode(graph, first);
  const original = graphModel(graph).edges;
  assert.deepEqual(
    original.map(({ from, to }) => [from, to]),
    [
      [INPUT, first.id],
      [first.id, OUTPUT],
    ],
  );
  const second = makeNode(option, graph.nodes);
  appendNode(graph, second);
  assert.deepEqual(graphModel(graph).edges, original);
  assert.equal(second.input.sources[0].content, null);
  assert.deepEqual(graph.output, { [first.id]: { $ref: "nodes." + first.id } });
  connectBinding(graph, INPUT, second.id, ["sources", "0", "content"]);
  connectBinding(graph, second.id, OUTPUT, [second.id]);
  assert(graphModel(graph).edges.some((e) => e.from === INPUT && e.to === second.id));
  assert(graphModel(graph).edges.some((e) => e.from === second.id && e.to === OUTPUT));
  const d = { ...definition, graphs: { main: graph } };
  checkDefinition(d);
});
test("editing an existing wire round-trips its condition and deleting it removes only that rule", () => {
  const graph = { nodes: [{ ...definition.graphs.main.nodes[0], input: { $ref: "input" } }] };
  const input = { from: INPUT, to: "load" },
    output = { from: "load", to: OUTPUT };
  const when = { $op: "gte", args: [{ $ref: "input.score" }, 4] };
  setCondition(graph, input, when);
  setCondition(graph, output, false);
  const wire = (from, to) => graphEdges(graph).find((edge) => edge.from === from && edge.to === to);
  checkDefinition({ ...definition, graphs: { main: graph } });
  assert.deepEqual(wire(INPUT, "load").when, when);
  assert.equal(wire("load", OUTPUT).when, false);
  disconnect(graph, input);
  pruneConditions(graph);
  assert.deepEqual(graph.conditions, [{ ...output, when: false }]);
  setCondition(graph, output, undefined);
  assert.equal(Object.hasOwn(wire("load", OUTPUT), "when"), false);
  assert.equal(Object.hasOwn(graph, "conditions"), false);
});

test("loop colors remain distinct across graphs and follow loops through reordering", () => {
  const loops = Array.from({ length: 12 }, (_, i) => ({ entry: "n" + i, end: "n" + i }));
  const values = assignLoopColors({ main: { loops }, child: { loops: [loops[0]] } });
  const colors = loops.map((r) => rangeColor(values, "main", r));
  assert.equal(new Set([...colors, rangeColor(values, "child", loops[0])]).size, 13);
  const reordered = assignLoopColors(
    { main: { loops: loops.toReversed() }, child: { loops: [loops[0]] } },
    JSON.parse(JSON.stringify(values)),
  );
  assert.deepEqual(
    loops.map((r) => rangeColor(reordered, "main", r)),
    colors,
  );
});
test("empty drafts round-trip without introducing runtime nodes or bypassing compiler checks", () => {
  const d = blankDefinition("empty");
  checkDefinition(d, true);
  assert.deepEqual(graphModel(d.graphs.main), { items: [], edges: [] });
  assert.throws(() => checkDefinition(d), /nonempty/);
  assert.throws(() => checkDefinition({ ...d, id: "bad id" }, true), /identifier/);
  d.graphs.main.output = { $ref: "nodes.missing" };
  assert.throws(() => checkDefinition(d, true), /reference/);
});
test("canvas history retains independent records and sees edits made by another tab", () => {
  const storage = Object.create({
    getItem(key) {
      return this[key] ?? null;
    },
    setItem(key, value) {
      this[key] = value;
    },
    removeItem(key) {
      delete this[key];
    },
  });
  const store = createCanvasHistory(storage, "project");
  const put = (id, name) => store.write({ id, definition: blankDefinition(name), filename: name + ".json" });
  put("a", "one");
  put("b", "two");
  store.select("b");
  const restored = createCanvasHistory(storage, "project");
  assert.equal(restored.active(), "b");
  assert.equal(restored.list().length, 2);
  put("a", "updated");
  assert.equal(restored.read("a").definition.id, "updated");
  assert.deepEqual(createCanvasHistory(storage, "separate").list(), []);
  restored.remove("b");
  assert.equal(store.active(), "a");
  assert.equal(store.read("b"), null);
  restored.remove("a");
  assert.equal(store.active(), null);
  assert.deepEqual(store.list(), []);
});
test("deleting a wire removes its bindings, respects literals and defaults, and keeps other outputs", () => {
  const d = structuredClone(definition);
  const graph = d.graphs.main;
  graph.nodes.push({
    id: "use",
    type: "CONTEXT.LOAD",
    dependsOn: ["load"],
    input: {
      a: { $ref: "nodes.load.items", default: [] },
      b: { $ref: "input" },
      literal: { $literal: { $ref: "nodes.load" } },
    },
  });
  disconnect(graph, { from: "load", to: "use" });
  assert.deepEqual(graph.nodes[1].input, {
    a: [],
    b: { $ref: "input" },
    literal: { $literal: { $ref: "nodes.load" } },
  });
  disconnect(graph, { from: INPUT, to: "use" });
  assert.equal(graph.nodes[1].input.b, null);
  disconnect(graph, { from: "use", to: OUTPUT });
  assert.deepEqual(graph.output, { load: { $ref: "nodes.load" } });
  connectBinding(graph, INPUT, "use", ["b"]);
  connectBinding(graph, INPUT, OUTPUT, ["incoming"]);
  assert.deepEqual(graph.output.incoming, { $ref: "input" });
  checkDefinition(d);
});
test("subgraph calls opt into input and their boundary edges follow the JSON", () => {
  const d = structuredClone(definition);
  d.graphs.child = newSubgraph();
  insertCall(d, "main", "child");
  insertCall(d, "main", "child", true);
  const edges = graphModel(d.graphs.main).edges;
  assert(!edges.some((e) => e.from === INPUT && e.to === "child"));
  assert(edges.some((e) => e.from === INPUT && e.to === "child2"));
  checkDefinition(d, true);
});
function respond(output, overrides = {}) {
  return discuss({
    provider: { invoke: async () => output },
    definition,
    graph: "main",
    command: "discuss",
    history: [],
    locale: "en",
    available: workers.filter((w) => !w.packageName).map((w) => w.name),
    t: translator("en"),
    check(value) {
      assert.deepEqual(validateAgent(value), []);
    },
    ...overrides,
  });
}
test("the picker covers every documented node and creates valid independent drafts", async () => {
  const docs = await readFile(new URL("../docs/node-coverage.md", import.meta.url), "utf8");
  const documented = Array.from(docs.matchAll(/^\| `([A-Z.]+)`/gm), (m) => m[1]);
  const options = workers.flatMap((w) => w.nodes);
  assert.deepEqual(options.map((n) => n.type).sort(), documented.sort());
  for (const option of options) {
    const n = makeNode(option, []),
      second = makeNode(option, [n]);
    assert.notEqual(n.id, second.id);
    assert.notEqual(n.input, second.input);
    assert.deepEqual(validateAgent({ ...definition, graphs: { main: { nodes: [n, second] } } }), []);
  }
});
test("a Markdown discussion returns prose and installed recommendations without editing the graph", async () => {
  const message =
    "## Recall\nTry **MEMORY.WRITE** and MEMORY.SEARCH. The optional RETRIEVAL.SEARCH is unavailable.";
  assert.deepEqual(await respond({ message: { content: message } }), {
    message,
    recommendations: ["MEMORY.WRITE", "MEMORY.SEARCH"],
  });
});
test("edits are validated separately and cannot add an unavailable optional node", async () => {
  const edit = structuredClone(definition);
  edit.graphs.main.conditions = [{ from: "load", to: OUTPUT, when: { $ref: "input.includeResult" } }];
  const reply = {
    actionRequests: [{ name: "apply_graph_edit", arguments: { message: "Done", definition: edit } }],
  };
  assert.deepEqual(await respond(reply), { message: "Done", definition: edit });
  edit.graphs.main.nodes.push(makeNode(workers.find((w) => w.name === "RETRIEVAL").nodes[0], []));
  await assert.rejects(respond(reply), /Optional package unavailable/);
});
test("a retried loop limit edit changes only the visitor queue cap", async () => {
  const museum = JSON.parse(await readFile(new URL("./examples/museum/agent.json", import.meta.url)));
  const expected = structuredClone(museum);
  expected.graphs.main.loops.find((loop) => loop.entry === "nextVisitor").maxIterations = 2;
  const call = {
    name: "set_loop_limit",
    arguments: { entry: "nextVisitor", end: "checkQueue", maxIterations: 2 },
  };
  let attempts = 0;
  const malformed = Object.assign(new Error("Unexpected non-whitespace character after JSON"), {
    code: "INVALID_MODEL_OUTPUT",
  });
  const result = await respond(null, {
    definition: museum,
    provider: { async invoke(input) {
      assert.ok(input.actions.some((action) => action.name === call.name));
      if (++attempts === 1) throw malformed;
      return { actionRequests: [call] };
    } },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result.definition, expected);
  assert.equal(museum.graphs.main.loops.find((loop) => loop.entry === "nextVisitor").maxIterations, 12);
  await assert.rejects(respond({ actionRequests: [call] }), /invalid edit/);
  attempts = 0;
  await assert.rejects(respond(null, { provider: { async invoke() { attempts++; throw malformed; } } }), /invalid edit/);
  assert.equal(attempts, 2);
});
test("follow-ups retain the opening document and recent complete turns within a budget", () => {
  const first = [
    { role: "user", content: "Document: design.md" },
    { role: "assistant", content: "Opening decision" },
  ];
  const history = [...first];
  for (let i = 0; i < 20; i++)
    history.push({ role: "user", content: "request " + i }, { role: "assistant", content: "reply " + i });
  const context = conversationContext(history);
  assert.deepEqual(context.slice(0, 2), first);
  assert.deepEqual(context.slice(-2), history.slice(-2));
  assert.equal(context.length, 26);
  assert.deepEqual(conversationContext([]), []);
});

test("model overrides reach the selected endpoint and keep keys out of public settings", async () => {
  const { createModelSettings } = await import("./models.mjs");
  const { createServer } = await import("node:http");
  const received = [];
  const endpoint = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ auth: req.headers.authorization, model: JSON.parse(Buffer.concat(chunks)).model });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      }),
    );
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  try {
    const settings = createModelSettings({
      providers: {},
      sandbox: { network: [] },
      workspace: process.cwd(),
    });
    const base = "http://127.0.0.1:" + endpoint.address().port;
    const input = { id: "@custom", model: "demo-model", key: "fixture-key", baseUrl: base };
    const t = translator("en");
    const state = settings.update(input, t);
    assert(!JSON.stringify(state).includes("fixture-key"));
    assert.equal(state.providers.find((p) => p.custom).hasKey, true);
    settings.update({ ...input, key: "", model: "second" }, t);
    const invoke = () =>
      settings.active.provider.invoke(
        { model: settings.active.model, messages: [{ role: "user", content: "Hello" }] },
        { signal: new AbortController().signal },
      );
    await invoke();
    settings.update({ ...input, key: "", baseUrl: base + "/different" }, t);
    await invoke();
    assert.deepEqual(received, [
      { auth: "Bearer fixture-key", model: "second" },
      { auth: undefined, model: "demo-model" },
    ]);
    assert.equal(settings.update({ reset: true }, t).overridden, false);
    assert.equal(settings.active, undefined);
  } finally {
    await new Promise((resolve) => endpoint.close(resolve));
  }
});

test("a linked subgraph and a bounded loop run through the same runtime as the editor JSON", async () => {
  const { newSubgraph, newLoop, insertCall, appendStep } = await import("./structure.js");
  const { createAgent } = await import("@codesoul-co/ditto/runtime");
  const { createContextWorker } = await import("@codesoul-co/ditto/worker/context");
  const d = structuredClone(definition);
  d.graphs.recall = newSubgraph();
  const loader = makeNode(workers[0].nodes[0], []);
  d.graphs.recall.nodes.push(loader);
  d.graphs.recall.output = { $ref: "nodes." + loader.id };
  insertCall(d, "main", "recall");
  d.loop = newLoop();
  const added = appendStep(d.loop, "main", "recall");
  assert.deepEqual(d.loop.steps.main.transitions.at(-1), { next: added });
  assert.equal(d.loop.maxIterations, 3);
  const agent = await createAgent(d, { workers: { context: createContextWorker() } });
  const iterations = new Set();
  try {
    const result = await agent.run("test", { onGraph: (e) => iterations.add(e.iteration) });
    assert.equal(result.items[0].content, "test");
    assert.equal(iterations.size, 3);
  } finally {
    await agent.close();
  }
});

test("the library example queries the handoff list only when books remain after the final trip", async (t) => {
  const { createAgent } = await import("@codesoul-co/ditto/runtime");
  const { createMemoryWorker } = await import("@codesoul-co/ditto/worker/memory");
  const { openSqliteMemory } = await import("../examples/_shared/tools/storage/sqlite-memory.ts");
  const example = JSON.parse(await readFile(new URL("./examples/library-returns.json", import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "ditto-returns-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memory = openSqliteMemory(join(dir, "returns.sqlite"));
  const reports = [];
  const store = {
    ...memory.store,
    query(input, options) {
      if (input.filter?.kind === "returned" && input.limit !== 1) reports.push(input.filter.namespace);
      return memory.store.query(input, options);
    },
  };
  try {
    const agent = await createAgent(example, { workers: { memory: createMemoryWorker({ store }) } });
    try {
      for (const count of [0, 5, 9]) {
        const batch = "batch-" + count;
        const titles = Array.from({ length: count }, (_, i) => "Book " + (i + 1));
        const result = await agent.run({ batch, titles });
        assert.equal(result.received, count);
        assert.equal(result.shelved.length, Math.min(count, 8));
        const receipts = await memory.store.query({ filter: { namespace: batch, kind: "receipt" } });
        assert.deepEqual(receipts.items.map((item) => item.content).sort(), [...result.shelved].sort());
        assert.deepEqual([...result.shelved, ...result.remaining].sort(), titles);
        assert.equal(result.complete, count <= 8);
      }
      assert.deepEqual(reports, ["batch-9"]);
    } finally {
      await agent.close();
    }
  } finally {
    await memory.close();
  }
});

test("the museum's reachable graphs cover the entire Worker catalog and route rejected replies to staff", async () => {
  const example = JSON.parse(await readFile(new URL("./examples/museum/agent.json", import.meta.url)));
  assert.deepEqual(validateAgent(example), []);
  const types = new Set();
  function visit(graph) {
    for (const node of graph.nodes) {
      if (node.kind === "subgraph") visit(example.graphs[node.graph]);
      else types.add(node.type);
    }
  }
  visit(example.graphs.main);
  assert.equal(Object.keys(example.graphs).length, 3);
  assert.deepEqual(
    example.graphs.main.loops.map(({ entry, end }) => [entry, end]),
    [
      ["nextVisitor", "checkQueue"],
      ["dailyNotice", "dailyNotice"],
      ["reviewReply", "reviewReply"],
    ],
  );
  assert.deepEqual(types, new Set(workers.flatMap((worker) => worker.nodes.map((node) => node.type))));
  const { createAgent } = await import("@codesoul-co/ditto/runtime");
  const { createInteractionWorker } = await import("@codesoul-co/ditto/worker/interaction");
  const delivered = [];
  const agent = await createAgent(
    { version: 1, id: "routing", graphs: { main: example.graphs.disposition } },
    {
      workers: {
        interaction: createInteractionWorker({
          output: {
            async deliver(input) {
              delivered.push(input);
              return { deliveryId: input.deliveryId, status: "accepted" };
            },
          },
        }),
      },
    },
  );
  try {
    for (const passed of [false, true]) {
      const review = {
        passed,
        feedback: "Check the price",
        answer: { role: "assistant", content: "USD 29" },
      };
      const result = await agent.run({ key: "family", queueId: "family-review", review });
      assert.equal(result.kind, passed ? "accepted" : "needs-review");
    }
    assert.deepEqual(
      delivered.map((input) => [input.deliveryId, input.message.content]),
      [
        ["family-review", "Check the price"],
        ["family", "USD 29"],
      ],
    );
  } finally {
    await agent.close();
  }
});
