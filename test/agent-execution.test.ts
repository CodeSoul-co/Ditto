import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  compileAgent, createAgent, createDitto, defineWorker, validateAgent, AgentValidationError,
  AgentPausedError, UncertainGraphCheckpointError, reconcileGraphCheckpoint, checkpointState,
  type AgentCheckpoint, type AgentDefinition, type GraphCheckpoint, type NodeType, type WorkerNodes,
} from "../src/index.js";

const ref = (path: string) => ({ $ref: path });
const node = (id: string, input: import("../src/index.js").JsonValue = ref("input")) => ({ id, type: "TEST.DURABLE.ECHO", input });
const worker = (execute: (value: unknown) => Promise<unknown> = async value => value) => defineWorker({
  type: "test", nodes: { ["TEST.DURABLE.ECHO" as NodeType]: execute } as WorkerNodes,
});
const definition = (): AgentDefinition => ({ version: 1, id: "durable", graphs: {
  main: { nodes: [node("route"), { ...node("confirm", ref("nodes.route")), dependsOn: ["route"] }], output: ref("nodes.confirm") },
  work: { nodes: [node("prepare"), { ...node("write", ref("nodes.prepare")), dependsOn: ["prepare"] }], output: ref("nodes.write") },
}, loop: { entry: "route", maxIterations: 2, state: { route: "work" }, steps: {
  route: { graph: "main", input: ref("input"), assign: { value: ref("result") }, transitions: [
    { when: { $op: "eq", args: [ref("state.route"), "stop"] }, end: "stopped" }, { next: "work" },
  ] },
  work: { graph: "work", input: ref("state.value"), transitions: [{ end: "completed" }] },
}, output: { value: ref("result"), reason: ref("termination.reason") } } });

test("runGraph uses selected bindings, projects Subgraphs, and preflights only the selected entry", async () => {
  const source = { ...definition(), deployment: { bindings: { main: { "child/one": "a" }, work: { one: "b" } } }, graphs: {
    main: { nodes: [{ id: "child", kind: "subgraph", graph: "work", input: ref("input") }], output: ref("nodes.child") },
    work: { nodes: [node("one"), { ...node("two", ref("nodes.one")), dependsOn: ["one"] }], output: { value: ref("nodes.two") } },
    unused: { nodes: [{ id: "unavailable", type: "MISSING.WORKER", input: null }] },
  } };
  const compiled = compileAgent(source), runtime = createDitto();
  runtime.register(worker(async () => "a"), { id: "a" });
  runtime.register(worker(async () => "b"), { id: "b" });
  try {
    assert.deepEqual(await compiled.runGraph("work", runtime, null, { workers: { one: "b", two: "b" } }), { value: "b" });
    assert.deepEqual(await compiled.runGraph("main", runtime, null, { workers: { "child/one": "a", "child/two": "a" } }), { value: "a" });
    await assert.rejects(compiled.run(runtime, null), /no registered Worker/);
    await assert.rejects(compiled.runGraph("missing", runtime, null), /unknown Graph/);
    await assert.rejects(compiled.runGraph("work", runtime, null, { workers: { one: "absent" } }), /no registered Worker/);
    assert.deepEqual(compiled.sourceMap.main?.["child/one"], { graphId: "work", nodeId: "one", path: "/graphs/work/nodes/0", invocationPath: ["child", "one"] });
  } finally { await runtime.close(); }
});

test("runGraph checkpoints include JSON expressions and selected bindings in their version", async () => {
  const source = definition(), runtime = createDitto({ workers: [worker()] });
  let saved: GraphCheckpoint | undefined, calls = 0;
  const handle = runtime.register(worker(async x => { calls++; return x; }), { id: "chosen" });
  const compiled = compileAgent(source), options = { workers: { route: "chosen", confirm: "chosen" }, checkpoint: {
    version: "resources-v1", save(cp: GraphCheckpoint) { saved = cp; },
  } };
  try {
    assert.equal(await compiled.runGraph("main", runtime, "value", options), "value");
    assert.equal(calls, 2);
    assert.equal(await compiled.runGraph("main", runtime, "value", { ...options, checkpoint: { ...options.checkpoint, resume: saved! } }), "value");
    assert.equal(calls, 2);
    await assert.rejects(compileAgent({ ...source, config: { changed: true } }).runGraph("main", runtime, "value", {
      ...options, checkpoint: { ...options.checkpoint, resume: saved! },
    }), /mismatch/);
    await assert.rejects(compiled.runGraph("main", runtime, "value", {
      checkpoint: { ...options.checkpoint, resume: saved! },
    }), /mismatch/);
  } finally { await handle.close(); await runtime.close(); }
});

test("awaited boundary patches state before routing, saves pause, and resumes without replay", async () => {
  let saved: AgentCheckpoint | undefined;
  const calls: unknown[] = [], agent = await createAgent(definition(), { workers: { echo: worker(async x => { calls.push(x); return x; }) } });
  const checkpoint = { id: "session-1", version: "host-1", save(cp: AgentCheckpoint) { saved = cp; } };
  try {
    await assert.rejects(agent.run("original", { stateCheckpoint: checkpoint, onBoundary: async boundary => {
      assert.equal(boundary.id, "session-1:1");
      assert.equal(boundary.state.value, "original");
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(calls.length, 2);
      return { update: { value: "message-added" }, pause: true };
    } }), AgentPausedError);
    assert.equal(saved?.state.step, "work"); assert.equal(saved?.state.iteration, 1);
    const events: number[] = [];
    assert.deepEqual(await agent.run("original", { stateCheckpoint: { ...checkpoint, resume: saved! },
      onGraph: event => { events.push(event.iteration); },
    }), { value: "message-added", reason: "completed" });
    assert.deepEqual(events, [1, 1]);
    assert.deepEqual(calls, ["original", "original", "message-added", "message-added"]);
    assert.deepEqual(await agent.run("original", { stateCheckpoint: { ...checkpoint, resume: saved! } }), { value: "message-added", reason: "completed" });
    assert.equal(calls.length, 4);
    assert.deepEqual(await agent.run("other", { onBoundary: () => ({ update: { route: "stop" } }) }), { value: "other", reason: "stopped" });
    assert.equal(calls.length, 6);
  } finally { await agent.close(); }
});

test("boundary failure repeats its stable ID, not the completed Graph; save failure admits no next step", async () => {
  let saved: AgentCheckpoint | undefined, calls = 0;
  const agent = await createAgent(definition(), { workers: { echo: worker(async x => { calls++; return x; }) } });
  const checkpoint = { id: "stable", version: "1", save(cp: AgentCheckpoint) { saved = cp; } };
  try {
    await assert.rejects(agent.run(1, { stateCheckpoint: checkpoint, onBoundary: boundary => {
      assert.equal(boundary.id, "stable:1"); throw new Error("inbox unavailable");
    } }), /inbox unavailable/);
    assert.equal(saved?.state.phase, "boundary");
    await assert.rejects(agent.run(1, { stateCheckpoint: { ...checkpoint, resume: saved!, save() { throw new Error("storage unavailable"); } },
      onBoundary: boundary => { assert.equal(boundary.id, "stable:1"); },
    }), /storage unavailable/);
    assert.equal(calls, 2);
  } finally { await agent.close(); }
});

test("Agent refuses different definitions, inputs and host versions before executing", async () => {
  let saved: AgentCheckpoint | undefined, calls = 0;
  const runtime = createDitto({ workers: [worker(async x => { calls++; return x; })] }), source = definition();
  const checkpoint = { id: "same", version: "1", save(cp: AgentCheckpoint) { saved = cp; } };
  try {
    await assert.rejects(compileAgent(source).run(runtime, "input", { stateCheckpoint: checkpoint, onBoundary: () => ({ pause: true }) }), AgentPausedError);
    const original = saved!;
    await assert.rejects(compileAgent({ ...source, config: { changed: true } }).run(runtime, "input", { stateCheckpoint: { ...checkpoint, resume: original } }), /incompatible/);
    await assert.rejects(compileAgent(source).run(runtime, "other", { stateCheckpoint: { ...checkpoint, resume: original } }), /incompatible/);
    await assert.rejects(compileAgent(source).run(runtime, "input", { stateCheckpoint: { ...checkpoint, version: "2", resume: original } }), /mismatch/);
    assert.equal(calls, 2);
  } finally { await runtime.close(); }
});

test("persisted dispatch intent blocks replay when an effect succeeds but completion save fails", async () => {
  let saved: AgentCheckpoint | undefined, calls = 0;
  const source = { version: 1, id: "effect", graphs: { main: { nodes: [node("write")], output: ref("nodes.write") } } };
  const agent = await createAgent(source, { workers: { echo: worker(async () => { calls++; return "written"; }) } });
  const checkpoint = { id: "write", version: "1", save(cp: AgentCheckpoint) {
    if (cp.state.graphCheckpoint && Object.hasOwn(cp.state.graphCheckpoint.state.outputs, "write")) throw new Error("disk full");
    saved = cp;
  } };
  try {
    await assert.rejects(agent.run(null, { stateCheckpoint: checkpoint }), /disk full/);
    assert.deepEqual(saved?.state.graphCheckpoint?.state.uncertain, ["write"]);
    const resume = saved!;
    await assert.rejects(agent.run(null, { stateCheckpoint: { ...checkpoint, resume } }), UncertainGraphCheckpointError);
    assert.equal(calls, 1);
    // Host checks the external receipt, then explicitly acknowledges the committed result.
    const graphCheckpoint = reconcileGraphCheckpoint(resume.state.graphCheckpoint!, { write: { output: "written" } });
    const resolved = checkpointState(resume.scope, resume.version, { ...resume.state, graphCheckpoint });
    assert.equal(await agent.run(null, { stateCheckpoint: { ...checkpoint, resume: resolved, save() {} } }), "written");
    assert.equal(calls, 1);
  } finally { await agent.close(); }
});

test("undefined Node outputs cannot silently erase confirmed writes from JSON checkpoints", async () => {
  let calls = 0, saved: AgentCheckpoint | undefined;
  const source = { version: 1, id: "undefined", graphs: { main: { nodes: [node("write")], output: null } } };
  const agent = await createAgent(source, { workers: { echo: worker(async () => { calls++; return undefined; }) } });
  const checkpoint = { id: "undefined", version: "1", save(cp: AgentCheckpoint) { saved = cp; } };
  try {
    await assert.rejects(agent.run(null, { stateCheckpoint: checkpoint }), /outputs must be JSON/);
    const resume = saved!;
    assert.deepEqual(resume.state.graphCheckpoint?.state.uncertain, ["write"]);
    assert.throws(() => reconcileGraphCheckpoint(resume.state.graphCheckpoint!, { write: { output: undefined } }), /Invalid operation resolution/);
    await assert.rejects(agent.run(null, { stateCheckpoint: { ...checkpoint, resume } }), UncertainGraphCheckpointError);
    assert.equal(calls, 1);
  } finally { await agent.close(); }
});

test("persistent iteration budget and public plan retain the same Loop semantics", async () => {
  const source = definition();
  const looping = { ...source, loop: { ...source.loop!, maxIterations: 1, steps: { route: {
    ...source.loop!.steps.route!, transitions: [{ next: "route" }],
  } } } };
  const agent = await createAgent(looping, { workers: { echo: worker() } });
  let saved: AgentCheckpoint | undefined;
  const checkpoint = { id: "limit", version: "1", save(cp: AgentCheckpoint) { saved = cp; } };
  try {
    await assert.rejects(agent.run(null, { stateCheckpoint: checkpoint, onBoundary: () => ({ pause: true }) }), AgentPausedError);
    await assert.rejects(agent.run(null, { stateCheckpoint: { ...checkpoint, resume: saved! } }), /iteration limit/);
    await assert.rejects(agent.runtime.loop(agent.compiled.plan, null), /iteration limit/);
  } finally { await agent.close(); }
});

test("intent save failure performs no work and parallel checkpoint waves respect concurrency", async () => {
  const source = { version: 1, id: "parallel", graphs: { main: { nodes: [node("a"), node("b"), node("c")] } } };
  let calls = 0, active = 0, maximum = 0;
  const agent = await createAgent(source, { workers: { echo: worker(async x => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--; return x;
  }) } });
  const checkpoint = { id: "waves", version: "1", save(cp: AgentCheckpoint) {
    assert.equal(active, 0);
    if (cp.state.graphCheckpoint?.state.uncertain.length) throw new Error("cannot persist intent");
  } };
  try {
    await assert.rejects(agent.run(null, { stateCheckpoint: checkpoint }), /cannot persist intent/);
    assert.equal(calls, 0);
    await agent.run(null, { concurrency: 2, stateCheckpoint: { ...checkpoint, save() { assert.equal(active, 0); } } });
    assert.equal(calls, 3); assert.equal(maximum, 2);
  } finally { await agent.close(); }
});

test("Runtime close drains an awaited boundary and the remaining accepted Agent steps", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let disposed = false, calls = 0;
  const custom = defineWorker({ type: "test", nodes: { ["TEST.DURABLE.ECHO" as NodeType]: async (x: unknown) => { calls++; return x; } } as WorkerNodes,
    dispose() { disposed = true; },
  });
  const agent = await createAgent(definition(), { workers: { echo: custom } });
  const running = agent.run("drain", { onBoundary: async boundary => {
    assert.ok(Object.isFrozen(boundary)); assert.ok(Object.isFrozen(boundary.state));
    if (boundary.iteration === 1) { entered.resolve(); await release.promise; }
  } });
  await entered.promise;
  const closing = agent.close();
  assert.equal(disposed, false); assert.equal(calls, 2);
  release.resolve();
  assert.deepEqual(await running, { value: "drain", reason: "completed" });
  await closing;
  assert.equal(disposed, true); assert.equal(calls, 4);
});

test("boundary cancellation and nonpersistent pause stop subsequent Graphs", async () => {
  let calls = 0;
  const agent = await createAgent(definition(), { workers: { echo: worker(async x => { calls++; return x; }) } });
  const controller = new AbortController();
  try {
    await assert.rejects(agent.run(null, { signal: controller.signal,
      onBoundary: () => { controller.abort(new Error("cancel at boundary")); },
    }), /cancel at boundary/);
    assert.equal(calls, 2);
    await assert.rejects(agent.run(null, { onBoundary: () => ({ pause: true }) }), /Pausing requires/);
    assert.equal(calls, 4);
  } finally { await agent.close(); }
});

test("final boundary cancellation preserves confirmed effects without committing the transition", async () => {
  let calls = 0, saved: AgentCheckpoint | undefined;
  const agent = await createAgent(definition(), { workers: { echo: worker(async x => { calls++; return x; }) } });
  const controller = new AbortController(), reason = new Error("cancel at final boundary");
  const stateCheckpoint = { id: "final-boundary", version: "1", save(cp: AgentCheckpoint) { saved = cp; } };
  try {
    await assert.rejects(agent.run("confirmed", { stateCheckpoint, signal: controller.signal,
      onBoundary: async boundary => {
        if (boundary.iteration !== 2) return;
        await Promise.resolve();
        controller.abort(reason);
        return { update: { value: "must not commit" } };
      },
    }), error => error === reason);
    assert.equal(calls, 4);
    assert.equal(saved?.state.phase, "boundary");
    assert.equal(saved?.state.step, "work");
    assert.equal(saved?.state.iteration, 2);
    assert.equal(saved?.state.state.value, "confirmed");
    assert.equal(saved?.state.result, "confirmed");
    assert.equal(saved?.state.termination, undefined);
    assert.deepEqual(await agent.run("confirmed", { stateCheckpoint: { ...stateCheckpoint, resume: saved! },
      onBoundary: boundary => { assert.equal(boundary.id, "final-boundary:2"); },
    }), { value: "confirmed", reason: "completed" });
    assert.equal(calls, 4);
    assert.equal(saved?.state.phase, "completed");
  } finally { await agent.close(); }
});

test("zero-iteration checkpoints complete without a Graph or a boundary callback", async () => {
  const source = definition();
  const agent = await createAgent({ ...source, loop: { ...source.loop!, while: false, output: ref("state") } },
    { workers: { echo: worker(async () => { throw new Error("must not run"); }) } });
  let saved: AgentCheckpoint | undefined;
  try {
    const stateCheckpoint = { id: "zero", version: "1", save(cp: AgentCheckpoint) { saved = cp; } };
    const onBoundary = () => { throw new Error("must not call"); };
    assert.deepEqual(await agent.run(null, { stateCheckpoint, onBoundary }), { route: "work" });
    assert.equal(saved?.state.phase, "completed"); assert.equal(saved?.state.iteration, 0);
    assert.deepEqual(await agent.run(null, { stateCheckpoint: { ...stateCheckpoint, resume: saved! }, onBoundary }), { route: "work" });
    assert.equal(agent.compiled.plan.plan(null).next().done, true);
  } finally { await agent.close(); }
});

test("compiler diagnostics locate nested expressions and source maps distinguish reused Subgraphs", () => {
  const source = definition();
  const invalid = { ...source, graphs: { main: { nodes: [node("bad", { payload: { $op: "eval", args: [] } })] } } };
  assert.deepEqual(validateAgent(invalid), [{ code: "INVALID_EXPRESSION", path: "/graphs/main/nodes/0/input/payload",
    graphId: "main", nodeId: "bad", message: "unknown operator or invalid argument count" }]);
  assert.throws(() => compileAgent(invalid), AgentValidationError);
  assert.equal(validateAgent({ ...source, unknown: true })[0]?.path, "/unknown");
  assert.deepEqual(validateAgent({ ...source, deployment: { bindings: { main: { missing: "worker" } } } })[0], {
    code: "UNKNOWN_NODE", path: "/deployment/bindings/main/missing", graphId: "main", nodeId: "missing", message: "unknown node main/missing",
  });
  const compiled = compileAgent({ ...source, graphs: { ...source.graphs, main: { nodes: ["left", "right"].map(id => ({
    id, kind: "subgraph", graph: "work", input: ref("input"),
  })) } } });
  assert.equal(compiled.sourceMap.main?.["left/write"]?.path, compiled.sourceMap.main?.["right/write"]?.path);
  assert.notDeepEqual(compiled.sourceMap.main?.["left/write"]?.invocationPath, compiled.sourceMap.main?.["right/write"]?.invocationPath);
  assert.deepEqual(validateAgent(source), []);
});

test("real process restart resumes confirmed steps; a crash after writing requires host reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-resume-"));
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const script = `
    import { createAgent } from ${JSON.stringify(moduleUrl)};
    import { defineWorker } from ${JSON.stringify(moduleUrl)};
    import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
    const [directory, mode] = process.argv.slice(1), path = directory + '/checkpoint.json';
    const source = ${JSON.stringify(definition())};
    let count = 0;
    const agent = await createAgent(source, { workers: { echo: defineWorker({ type: 'test', nodes: {
      'TEST.DURABLE.ECHO': async input => {
        appendFileSync(directory + '/effects', 'write\\n');
        if (mode === 'crash-effect') process.exit(18);
        return input;
      }
    } }) } });
    try {
      const output = await agent.run('value', { stateCheckpoint: { id: 'process', version: '1',
        ...(existsSync(path) ? { resume: JSON.parse(readFileSync(path, 'utf8')) } : {}),
        save(cp) {
          writeFileSync(path + '.tmp', JSON.stringify(cp)); renameSync(path + '.tmp', path);
          if (mode === 'crash-boundary' && cp.state.phase === 'boundary' && cp.state.iteration === 1) process.exit(17);
        }
      } });
      console.log(JSON.stringify(output));
    } finally { await agent.close(); }
  `;
  const run = (mode: string) => spawnSync(process.execPath, ["--input-type=module", "-e", script, directory, mode], { encoding: "utf8", timeout: 15_000 });
  try {
    assert.equal(run("crash-boundary").status, 17);
    const resumed = run("resume"); assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout), { value: "value", reason: "completed" });
    assert.equal((await readFile(join(directory, "effects"), "utf8")).trim().split("\n").length, 4);
    await rm(join(directory, "checkpoint.json")); await rm(join(directory, "effects"));
    assert.equal(run("crash-effect").status, 18);
    const uncertain = run("resume"); assert.notEqual(uncertain.status, 0); assert.match(uncertain.stderr, /uncertain operations/);
    assert.equal((await readFile(join(directory, "effects"), "utf8")).trim(), "write");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
