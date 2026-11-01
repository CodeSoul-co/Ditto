import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { NodeType } from "../src/contracts/index.js";
import { compileAgent, createAgent, createDitto, createRuntimeServices, loadRuntimeConfig, type AgentDefinition } from "../src/runtime/index.js";
import { defineWorker, type WorkerNodes } from "../src/worker/define-worker.js";
import { createInteractionWorker } from "../src/worker/interaction/index.js";

// Dynamic plugin boundary: typed augmentation is exercised by the external npm consumer.
const echoType = "TEST.JSON.ECHO" as NodeType;
const handlers = (execute: (input: unknown) => Promise<unknown>) => ({ [echoType]: execute }) as WorkerNodes;
const ref = (path: string) => ({ $ref: path });
const op = (operator: string, ...args: import("../src/contracts/common.js").JsonValue[]) => ({ $op: operator, args });
const echoNode = (id = "echo", input: import("../src/contracts/common.js").JsonValue = ref("input")) => ({ id, type: "TEST.JSON.ECHO", input });
const simple = (): AgentDefinition => ({ version: 1, id: "test", graphs: { main: { nodes: [echoNode()], output: ref("nodes.echo") } } });
const worker = (execute: (input: unknown) => Promise<unknown> = async input => input) => defineWorker({
  type: "test", nodes: handlers(execute),
});

test("JSON single main Graph, immutable configuration and host registration", async () => {
  const definition = simple();
  const agent = await createAgent(definition, { workers: { echo: worker() } });
  try {
    assert.deepEqual(await agent.run({ text: "hello" }), { text: "hello" });
    assert.deepEqual(agent.runtime.workers().map(w => w.address.workerId), ["echo"]);
    assert.ok(Object.isFrozen(agent.compiled.definition.graphs.main!.nodes));
    assert.deepEqual(await Promise.all([agent.run(1), agent.run(2)]), [1, 2]);
  } finally { await agent.close(); }
  await assert.rejects(agent.run("closed"), /no registered Worker/);
});

test("explicit null configuration is preserved", async () => {
  const definition = { ...simple(), config: null, graphs: { main: { nodes: [echoNode("echo", ref("config"))], output: ref("nodes.echo") } } };
  const agent = await createAgent(definition, { workers: { echo: worker() } });
  try { assert.equal(await agent.run("input"), null); }
  finally { await agent.close(); }
});

for (const [projection, output] of Object.entries({
  direct: ref("nodes.echo"),
  mapped: { $map: { items: ref("nodes.echo"), value: ref("item") } },
})) test(`serial Subgraphs keep linear dependencies and avoid repeated upstream projections (${projection})`, async t => {
  const count = 256;
  const definition = { version: 1, id: "chain", graphs: {
    main: { nodes: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, kind: "subgraph", graph: "child", dependsOn: i ? [`n${i - 1}`] : [],
      input: ref(i ? `nodes.n${i - 1}` : "input"),
    })), output: ref(`nodes.n${count - 1}`) },
    child: { nodes: [echoNode()], output },
  } };
  const agent = await createAgent(definition, { workers: { echo: worker() } });
  let clones = 0;
  const original = structuredClone;
  const mocked = t.mock.method(globalThis, "structuredClone", (value: unknown) => { clones++; return original(value); });
  try {
    assert.equal(agent.compiled.graphs.main!.tasks.reduce((sum, task) => sum + task.dependencies.length, 0), count - 1);
    assert.deepEqual(await agent.run(["first"]), ["first"]);
    assert.ok(clones < count * 8, `Unexpected repeated cloning: ${clones}`);
    assert.deepEqual(await Promise.all([agent.run(["second"]), agent.run(["third"])]), [["second"], ["third"]]);
  } finally { mocked.mock.restore(); await agent.close(); }
});

test("default Subgraph outputs are materialized during execution, including input-derived projections", async () => {
  const source = { version: 1, id: "defaults", graphs: {
    main: { nodes: [echoNode("seed"), { id: "child", kind: "subgraph", graph: "child", dependsOn: ["seed"], input: ref("nodes.seed") }] },
    child: { nodes: [echoNode()], output: { input: ref("input"), result: ref("nodes.echo") } },
  } };
  const agent = await createAgent(source, { workers: { echo: worker() } });
  try {
    const result = await agent.run("value");
    assert.deepEqual(result, { seed: "value", child: { input: "value", result: "value" } });
    assert.equal(Object.getOwnPropertyDescriptor(result, "child")?.get, undefined);
  } finally { await agent.close(); }
  const invalid = await createAgent({ ...source, graphs: { ...source.graphs,
    child: { ...source.graphs.child, output: ref("input.missing") },
  } }, { workers: { echo: worker() } });
  try { await assert.rejects(invalid.run({}), /missing reference/); }
  finally { await invalid.close(); }
});

test("shared Node implementations reuse one Worker across Subgraphs, Loop iterations and concurrent runs", async () => {
  let created = 0, disposed = 0, calls = 0;
  const shared = defineWorker({ type: "shared", resources: () => { created++; return undefined; },
    dispose: () => { disposed++; }, nodes: handlers(async input => { calls++; await delay(1); return input; }),
  });
  const source: AgentDefinition = { version: 1, id: "reuse", graphs: {
    main: { nodes: [
      { id: "left", kind: "subgraph", graph: "shared", input: { value: ref("input.value"), branch: "left" } },
      { id: "right", kind: "subgraph", graph: "shared", input: { value: ref("input.value"), branch: "right" } },
    ] },
    shared: { nodes: [echoNode()], output: ref("nodes.echo") },
  }, loop: { entry: "run", maxIterations: 2, state: { round: 0 }, steps: {
    run: { graph: "main", input: ref("input"), assign: { round: op("add", ref("state.round"), 1) },
      transitions: [{ when: op("gte", ref("state.round"), 2), end: "completed" }, { next: "run" }],
    },
  }, output: ref("result") }, deployment: {
    workers: [{ id: "shared", use: "shared" }],
    bindings: { main: { "left/echo": "shared", "right/echo": "shared" } },
  } };
  const agent = await createAgent(source, { workers: { shared } });
  try {
    const results = await Promise.all([agent.run({ value: "one" }), agent.run({ value: "two" })]);
    assert.deepEqual(results, ["one", "two"].map(value => ({ left: { value, branch: "left" }, right: { value, branch: "right" } })));
    assert.equal(created, 1); assert.equal(calls, 8); assert.equal(disposed, 0);
  } finally { await agent.close(); }
  assert.equal(disposed, 1);
});

test("Subgraphs expand with isolated inputs, transitive dependencies, output projections and parallel readiness", async () => {
  let active = 0, maximum = 0;
  const definition = {
    version: 1, id: "nested", graphs: {
      main: { nodes: [
        { id: "last", kind: "subgraph", graph: "pair", dependsOn: ["second"], input: ref("nodes.second") },
        { id: "second", kind: "subgraph", graph: "pair", dependsOn: ["first"], input: ref("nodes.first") },
        echoNode("first"),
      ], output: ref("nodes.last") },
      pair: { nodes: [echoNode("a"), echoNode("b")], output: { original: ref("input"), a: ref("nodes.a"), b: ref("nodes.b") } },
    },
  };
  const agent = await createAgent(definition, { workers: { echo: worker(async input => {
    active++; maximum = Math.max(maximum, active); await delay(5); active--; return input;
  }) } });
  try {
    const result = await agent.run("start") as { original: unknown };
    assert.deepEqual(result.original, { original: "start", a: "start", b: "start" });
    assert.equal(maximum, 2);
    assert.deepEqual(agent.compiled.graphs.main!.tasks.map(t => t.id), ["first", "second/a", "second/b", "last/a", "last/b"]);
  } finally { await agent.close(); }
});

function counter(): AgentDefinition {
  return { version: 1, id: "counter", config: { increment: 1 }, graphs: {
    main: { nodes: [echoNode()], output: ref("nodes.echo") },
    unused: { nodes: [echoNode("never", "should-not-run")] },
  }, loop: {
    entry: "repeat", maxIterations: 4, state: { count: 0, previous: -1, results: [] },
    while: op("lt", ref("state.count"), ref("input.limit")),
    steps: { repeat: { graph: "main", input: ref("state.count"), assign: {
      count: op("add", ref("state.count"), ref("config.increment")),
      previous: ref("state.count"), results: op("append", ref("state.results"), ref("result")),
    }, transitions: [
      { when: op("gte", ref("state.count"), ref("input.limit")), end: "completed" },
      { next: "repeat" },
    ] } },
    output: { count: ref("state.count"), previous: ref("state.previous"), results: ref("state.results") },
  } };
}
test("Loop owns repeat, atomic assignments, zero iterations and a shared Graph budget", async () => {
  const calls: unknown[] = [];
  const agent = await createAgent(counter(), { workers: { echo: worker(async input => { calls.push(input); return input; }) } });
  try {
    assert.deepEqual(await agent.run({ limit: 3 }), { count: 3, previous: 2, results: [0, 1, 2] });
    assert.deepEqual(calls, [0, 1, 2]);
    assert.deepEqual(await agent.run({ limit: 0 }), { count: 0, previous: -1, results: [] });
    calls.length = 0;
    await assert.rejects(agent.run({ limit: 10 }), /iteration limit/);
    assert.deepEqual(calls, [0, 1, 2, 3]);
  } finally { await agent.close(); }
});

test("main router selects exactly one subsequent Graph", async () => {
  const definition = { version: 1, id: "router", graphs: {
    main: { nodes: [echoNode()], output: ref("nodes.echo") },
    left: { nodes: [echoNode("effect", "left")], output: ref("nodes.effect") },
    right: { nodes: [echoNode("effect", "right")], output: ref("nodes.effect") },
  }, loop: { entry: "route", maxIterations: 2, state: {}, steps: {
    route: { graph: "main", input: ref("input"), transitions: [
      { when: op("eq", ref("result"), "left"), next: "left" }, { next: "right" },
    ] },
    left: { graph: "left", input: null, transitions: [{ end: "completed" }] },
    right: { graph: "right", input: null, transitions: [{ end: "completed" }] },
  }, output: ref("result") } };
  const calls: unknown[] = [];
  const agent = await createAgent(definition, { workers: { echo: worker(async input => { calls.push(input); return input; }) } });
  try { assert.equal(await agent.run("left"), "left"); assert.deepEqual(calls, ["left", "left"]); }
  finally { await agent.close(); }
});

test("output requirements stop dependent effects, including subgraph boundaries", async () => {
  const calls: unknown[] = [];
  const definition = { version: 1, id: "failure", graphs: {
    main: { nodes: [
      { id: "child", kind: "subgraph", graph: "checked", input: null },
      { ...echoNode("effect", "must-not-run"), dependsOn: ["child"] },
    ] },
    checked: { nodes: [{ ...echoNode(), require: { path: "status", equals: "success" } }] },
  } };
  const agent = await createAgent(definition, { workers: { echo: worker(async input => { calls.push(input); return { status: "failed" }; }) } });
  try { await assert.rejects(agent.run(null), /output requirement failed/); assert.deepEqual(calls, [null]); }
  finally { await agent.close(); }
});

test("compiled expressions map, default, literal data and short-circuit conditions without eval", async () => {
  const definition = simple();
  const source = { ...definition, config: { label: "test" }, graphs: { main: {
    nodes: [echoNode("echo", {
      mapped: { $map: { items: ref("input.values"), value: op("add", ref("item"), ref("index")) } },
      fallback: { $ref: "input.missing", default: "default" },
      literal: { $literal: { $ref: "not-a-reference" } },
      safe: op("or", true, ref("input.missing")), label: ref("config.label"),
    })], output: ref("nodes.echo"),
  } } };
  const agent = await createAgent(source, { workers: { echo: worker() } });
  try {
    assert.deepEqual(await agent.run({ values: [3, 3] }), {
      mapped: [3, 4], fallback: "default", literal: { $ref: "not-a-reference" }, safe: true, label: "test",
    });
    await assert.rejects(agent.run({}), /missing reference/);
  } finally { await agent.close(); }
});

test("invalid definitions fail before any Worker is instantiated", async () => {
  let instantiated = 0;
  const host = defineWorker({ type: "test", resources: () => { instantiated++; return undefined; }, nodes: handlers(async x => x) });
  const cases: [unknown, RegExp][] = [
    [{ ...simple(), deployment: null }, /expected an object/],
    [{ ...simple(), deployment: { bindings: null } }, /expected an object/],
    [{ ...simple(), graphs: { main: { nodes: [{ ...echoNode(), dependsOn: null }] } } }, /must be an array/],
    [{ ...counter(), loop: { ...counter().loop!, steps: { repeat: { ...counter().loop!.steps.repeat!, assign: null } } } }, /expected an object/],
    [{ ...simple(), graphs: { other: { nodes: [echoNode()] } } }, /main Graph/],
    [{ ...simple(), permissions: { execute: true } }, /unknown field/],
    [{ ...simple(), entry: "other" }, /entry must be main/],
    [{ ...simple(), graphs: { main: { nodes: [echoNode(), echoNode()] } } }, /duplicate node/],
    [{ ...simple(), graphs: { main: { nodes: [{ ...echoNode(), dependsOn: ["absent"] }] } } }, /unknown dependency/],
    [{ ...simple(), graphs: { main: { nodes: [{ ...echoNode(), dependsOn: ["echo"] }] } } }, /cyclic dependency/],
    [{ ...simple(), graphs: { main: { nodes: [echoNode("x", ref("nodes.y")), echoNode("y")] } } }, /declared dependency/],
    [{ ...simple(), graphs: { main: { nodes: [{ id: "recursive", kind: "subgraph", graph: "main", input: null }] } } }, /recursive/],
    [{ ...simple(), graphs: { main: { nodes: [echoNode("x", { $ref: "input.__proto__.x" })] } } }, /invalid reference/],
    [{ ...simple(), graphs: { main: { nodes: [echoNode("x", { $op: "eval", args: [] })] } } }, /unknown operator/],
    [{ ...simple(), graphs: { main: { nodes: [echoNode("x", op("add", 1))] } } }, /argument count/],
    [{ ...counter(), loop: { ...counter().loop!, entry: "missing" } }, /unknown step/],
    [{ ...counter(), loop: { ...counter().loop!, maxIterations: 0 } }, /positive integer/],
    [JSON.parse('{"version":1,"__proto__":{}}'), /forbidden key/],
  ];
  for (const [definition, expected] of cases) await assert.rejects(createAgent(definition, { workers: { host } }), expected);
  assert.equal(instantiated, 0);
});

test("unknown capabilities, bindings and registry references fail in preflight", async () => {
  const bad = { ...simple(), graphs: { main: { nodes: [{ ...echoNode(), type: "UNKNOWN.NODE" }] } } };
  await assert.rejects(createAgent(bad, { workers: { echo: worker() } }), /no registered Worker/);
  await assert.rejects(createAgent({ ...simple(), deployment: { workers: [{ id: "x", use: "absent" }] } }, { workers: {} }), /unknown host Worker/);
  await assert.rejects(createAgent({ ...simple(), deployment: { bindings: { main: { missing: "echo" } } } }, { workers: { echo: worker() } }), /unknown node/);
  await assert.rejects(createAgent({ ...simple(), deployment: { bindings: { main: { echo: "absent" } } } }, { workers: { echo: worker() } }), /no registered Worker/);
  const runtime = createDitto();
  try { await assert.rejects(compileAgent(simple()).run(runtime, null), /no registered Worker/); }
  finally { await runtime.close(); }
});

test("deployment aliases bind flattened leaves to real Worker instances", async () => {
  const agent = await createAgent({ version: 1, id: "bound", graphs: {
    main: { nodes: [{ id: "child", kind: "subgraph", graph: "child", input: null }], output: ref("nodes.child") },
    child: { nodes: [echoNode()], output: ref("nodes.echo") },
  }, deployment: { workers: [{ id: "selected", use: "b" }], bindings: { main: { "child/echo": "selected" } } } },
  { workers: { a: worker(async () => "a"), b: worker(async () => "b") } });
  try { assert.equal(await agent.run(null), "b"); assert.equal(agent.runtime.workers().length, 1); }
  finally { await agent.close(); }
});

test("host permission profiles govern tool effects; JSON cannot grant permissions", async () => {
  let effects = 0;
  const tools = createInteractionWorker({ tools: [{ name: "effect", inputSchema: {}, validate() {},
    async execute() { effects++; return { status: "success", content: "ok" }; },
  }] });
  const definition = { version: 1, id: "permissions", graphs: { main: { nodes: [{ id: "call", type: "INTERACTION.ACT.TOOL",
    input: { call: { id: "call-1", name: "effect", arguments: {} } } }], output: ref("nodes.call.content") } },
    deployment: { workers: [{ id: "tools", use: "tools", services: "restricted" }] } };
  const agent = await createAgent(definition, { workers: { tools },
    serviceProfiles: { restricted: createRuntimeServices({ config: loadRuntimeConfig({}), sandbox: { tools: [] } }) },
  });
  try { await assert.rejects(agent.run(null), /Permission denied/); assert.equal(effects, 0); }
  finally { await agent.close(); }
  await assert.rejects(createAgent(definition, { workers: { tools } }), /unknown host services profile/);
});

test("registration failure disposes previous registrations; cancellation stops later Graphs", async () => {
  let disposed = 0;
  const first = defineWorker({ type: "first", nodes: handlers(async x => x), dispose() { disposed++; } });
  const broken = defineWorker({ type: "broken", resources() { throw new Error("resource failure"); }, nodes: handlers(async x => x) });
  await assert.rejects(createAgent(simple(), { workers: { first, broken } }), /resource failure/);
  assert.equal(disposed, 1);
  const controller = new AbortController(); let calls = 0;
  const agent = await createAgent(counter(), { workers: { echo: worker(async input => { calls++; controller.abort(new Error("stop")); return input; }) } });
  try { await assert.rejects(agent.run({ limit: 3 }, { signal: controller.signal }), /stop/); assert.equal(calls, 1); }
  finally { await agent.close(); }
});

test("large canvas DAGs compile in arbitrary order without recursive dependency traversal", () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({
    ...echoNode(`n${i}`, i ? ref(`nodes.n${i - 1}`) : 0), dependsOn: i ? [`n${i - 1}`] : [],
  })).reverse();
  const compiled = compileAgent({ ...simple(), graphs: { main: { nodes } } });
  assert.equal(compiled.graphs.main!.tasks.length, 5000);
  assert.equal(compiled.graphs.main!.tasks[0]!.id, "n0");
  assert.equal(compiled.graphs.main!.tasks.at(-1)!.id, "n4999");
});

test("Loop rejects nonboolean conditions, missing defaults, wrong main entry and checkpoints", async () => {
  const source = counter();
  assert.throws(() => compileAgent({ ...source, loop: { ...source.loop, steps: {
    repeat: { ...source.loop!.steps.repeat, graph: "unused" },
  } } }), /first step must execute the main/);
  assert.throws(() => compileAgent({ ...source, loop: { ...source.loop, steps: {
    repeat: { ...source.loop!.steps.repeat, transitions: [{ when: true, end: "completed" }] },
  } } }), /unconditional default/);
  const agent = await createAgent({ ...source, loop: { ...source.loop, while: "yes" } }, { workers: { echo: worker() } });
  try {
    await assert.rejects(agent.run({ limit: 1 }), /condition must return a boolean/);
    await assert.rejects(agent.run(null, { stateCheckpoint: { id: "test", version: "1", save: async () => {} } }), /do not serialize/);
  } finally { await agent.close(); }
});
