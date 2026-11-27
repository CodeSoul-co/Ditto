import assert from "node:assert/strict";
import test from "node:test";
import { createAgent, createDitto, createContextWorker, defineWorker, graph, reconcileGraphCheckpoint, type AgentCheckpoint, type ExecutionEvent, type GraphCheckpoint } from "../src/index.js";

test("graph retries across a restart retain the operation ID; only validated results commit", async () => {
  const events: ExecutionEvent[] = [];
  const open = () => createDitto({ workers: [createContextWorker()], onExecutionEvent(event) { events.push(event); } });
  let valid = false;
  const plan = graph("job").node("load", "CONTEXT.LOAD", [], () => ({ sources: [] }), () => {
    if (!valid) throw new Error("invalid output");
  });
  let saved!: GraphCheckpoint;
  const checkpoint = { version: "1", save(value: GraphCheckpoint) { saved = value; } };
  const first = open();
  await assert.rejects(first.run(plan, {}, { checkpoint }), /invalid output/);
  await first.close();
  assert.ok(events.some(e => e.type === "attempt.succeeded"));
  assert.ok(!events.some(e => e.type === "operation.committed"));
  assert.deepEqual(saved.state.uncertain, ["load"]);
  const second = open();
  valid = true;
  const resume = reconcileGraphCheckpoint(saved, { load: { retry: true } }, e => { events.push(e); });
  assert.ok(events.some(e => e.type === "checkpoint.reconciled" && e.digest === resume.digest && e.retry[0] === "load"));
  await second.run(plan, {}, { checkpoint: { ...checkpoint, resume } });
  const attempts = events.filter(e => e.type === "attempt.started");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.operationId, attempts[1]!.operationId);
  assert.notEqual(attempts[0]!.attemptId, attempts[1]!.attemptId);
  const commits = events.filter(e => e.type === "operation.committed");
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.attemptId, attempts[1]!.attemptId);
  assert.ok(events.some(e => e.type === "checkpoint.restored" && e.digest === resume.digest));
  assert.ok(events.at(-1)?.type === "checkpoint.saved");
  await second.close();
});

test("observer errors cannot change the result or acknowledge failed persistence", async () => {
  const seen: string[] = [];
  const runtime = createDitto({ workers: [createContextWorker()], onExecutionEvent: async event => {
    seen.push(event.type);
    throw new Error("observer offline");
  } });
  assert.deepEqual(await runtime.invoke("CONTEXT.LOAD", { sources: [] }), { items: [] });
  assert.deepEqual(seen, ["operation.dispatched", "attempt.started", "attempt.succeeded", "operation.committed"]);
  const plan = graph("test").node("load", "CONTEXT.LOAD", [], () => ({ sources: [] }));
  await assert.rejects(runtime.run(plan, {}, { checkpoint: { version: "1", save() { throw new Error("store offline"); } } }), /store offline/);
  assert.ok(!seen.includes("checkpoint.saved"));
  await runtime.close();
});

test("configured Agent iterations share execution identity, have distinct operations, and completed resume only restores", async () => {
  const events: ExecutionEvent[] = [];
  const agent = await createAgent({
    version: 1, id: "traced", graphs: { main: { nodes: [{ id: "load", type: "CONTEXT.LOAD", input: { sources: [] } }] } },
    loop: { entry: "again", maxIterations: 2, state: { count: 0 }, steps: {
      again: { graph: "main", input: {}, assign: { count: { $op: "add", args: [{ $ref: "state.count" }, 1] } },
        transitions: [{ when: { $op: "eq", args: [{ $ref: "state.count" }, 2] }, end: "done" }, { next: "again" }] },
    } },
  }, { workers: { context: createContextWorker() }, onExecutionEvent(e) { events.push(e); } });
  let saved!: AgentCheckpoint;
  const checkpoint = { id: "session", version: "1", save(value: AgentCheckpoint) { saved = value; } };
  try {
    await agent.run({}, { stateCheckpoint: checkpoint });
    const commits = events.filter(e => e.type === "operation.committed");
    assert.equal(commits.length, 2);
    assert.notEqual(commits[0]!.operationId, commits[1]!.operationId);
    assert.ok(commits.every(c => c.execution?.executionId === "session"));
    events.length = 0;
    await agent.run({}, { stateCheckpoint: { ...checkpoint, resume: saved } });
    assert.deepEqual(events.map(e => e.type), ["checkpoint.restored"]);
  } finally { await agent.close(); }
});

test("inference usage and worker invocation metadata belong to the successful attempt", async () => {
  const events: ExecutionEvent[] = [];
  const worker = defineWorker({ type: "INFER", nodes: {
    "INFER.REASONING.SAMPLE": async (_input, ctx) => {
      assert.ok(ctx.invocation);
      return { executionId: ctx.invocation.operationId, node: "INFER.REASONING.SAMPLE", status: "success",
        output: { message: { role: "assistant", content: ctx.invocation.attemptId }, finishReason: "stop", usage: { totalTokens: 4 } } };
    },
  } });
  const runtime = createDitto({ workers: [worker], onExecutionEvent(e) { events.push(e); } });
  try {
    const result = await runtime.invoke("INFER.REASONING.SAMPLE", { messages: [], model: { model: "test" } });
    const success = events.find(e => e.type === "attempt.succeeded");
    assert.ok(success);
    assert.equal(success.operationId, result.executionId);
    assert.equal(success.attemptId, result.output?.message.content);
    assert.equal(success.usage?.totalTokens, 4);
  } finally { await runtime.close(); }
});
