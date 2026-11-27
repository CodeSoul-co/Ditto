import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  createDitto, createIpcTransport, graph, TransportError,
  type ExecutionEvent, type InvocationEnvelope, type InvokeTransport, type RecoveryPolicy, type WorkerAddress,
} from "../src/index.js";

function register(runtime: ReturnType<typeof createDitto>, workerId: string, transportId: string) {
  runtime.registerRemote({ address: { workerId, workerType: "MEMORY", hostId: "remote", processId: workerId },
    capabilities: ["MEMORY.GET"], transportId });
}
function fixture(policy: RecoveryPolicy | undefined, send: InvokeTransport["invoke"], count = 2) {
  const events: ExecutionEvent[] = [], calls: InvocationEnvelope[] = [];
  const runtime = createDitto({ ...(policy && { recoveryPolicy: policy }), onExecutionEvent(e) { events.push(e); },
    transports: [{ id: "test", invoke(envelope, options) { calls.push(envelope); return send(envelope, options); } }] });
  for (let i = 0; i < count; i++) register(runtime, String(i), "test");
  return { runtime, events, calls };
}

test("an unsent call can fail over once with one logical commit and fresh wire IDs", async () => {
  const { runtime, calls, events } = fixture({ maxAttempts: 2 }, async envelope => {
    if (envelope.target.workerId === "0") throw new TransportError("CHANNEL_CLOSED", "not_sent", envelope, "gone");
    return { invocationId: envelope.id, payload: { kind: "inline", value: {} } };
  });
  const plan = graph("read").node("get", "MEMORY.GET", [], () => ({}));
  await runtime.run(plan, {});
  assert.deepEqual(calls.map(c => c.target.workerId), ["0", "1"]);
  assert.equal(new Set(calls.map(c => c.id)).size, 2);
  const attempts = events.filter(e => e.type === "attempt.started");
  assert.deepEqual(attempts.map(a => a.attemptId), calls.map(c => c.id));
  assert.ok(calls.every(c => c.operationId === attempts[0]!.operationId));
  assert.deepEqual(events.map(e => e.type), ["operation.dispatched", "attempt.started", "attempt.failed",
    "recovery.decided", "attempt.started", "attempt.succeeded", "operation.committed"]);
  await runtime.close();
});

test("defaults, hard pins, unknown outcomes and invalid requests do not move to another worker", async () => {
  for (const [policy, pinned, code, status] of [
    [undefined, false, "CHANNEL_CLOSED", "not_sent"],
    [{ maxAttempts: 3, shouldRetry: () => true }, true, "CHANNEL_CLOSED", "not_sent"],
    [{ maxAttempts: 3 }, false, "TIMEOUT", "outcome_unknown"],
    [{ maxAttempts: 3, shouldRetry: () => true }, false, "INVALID_REQUEST", "not_sent"],
  ] as const) {
    const { runtime, calls } = fixture(policy, async envelope => { throw new TransportError(code, status, envelope, "failed"); });
    await assert.rejects(runtime.invoke("MEMORY.GET", {}, pinned ? { workerId: "0" } : {}), { code, status });
    assert.equal(calls.length, 1);
    await runtime.close();
  }
});

test("budget and replica exhaustion preserve the last transport failure and never revisit a worker", async () => {
  for (const [limit, replicas] of [[2, 5], [5, 2]] as const) {
    const { runtime, calls } = fixture({ maxAttempts: limit }, async envelope => {
      throw new TransportError("WORKER_EXITED", "not_sent", envelope, "gone");
    }, replicas);
    await assert.rejects(runtime.invoke("MEMORY.GET", {}), (e: unknown) =>
      e instanceof TransportError && e.invocationId === calls.at(-1)?.id);
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map(c => c.target.workerId)).size, 2);
    await runtime.close();
  }
});

test("cancellation during an asynchronous recovery decision prevents redispatch", async () => {
  const controller = new AbortController();
  const { runtime, calls } = fixture({ maxAttempts: 2, async shouldRetry() {
    await Promise.resolve();
    controller.abort(new Error("cancel recovery"));
    return true;
  } }, async envelope => { throw new TransportError("TIMEOUT", "outcome_unknown", envelope, "timeout"); });
  await assert.rejects(runtime.invoke("MEMORY.GET", {}, { signal: controller.signal }), /cancel recovery/);
  assert.equal(calls.length, 1);
  await runtime.close();
});

test("after a real IPC worker exits, an approved read continues on a second replica", async () => {
  const child = fork(new URL("./fixtures/runtime-worker.js", import.meta.url), [], {
    env: { ...process.env, TEST_WORKER_TOKEN: "local-test" }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  const ipc = createIpcTransport({ id: "ipc", channel: child });
  const events: ExecutionEvent[] = [];
  const runtime = createDitto({ transports: [ipc, { id: "backup", async invoke(envelope) {
    return { invocationId: envelope.id, payload: { kind: "inline", value: { status: "success", output: [] } } };
  } }], recoveryPolicy: { maxAttempts: 2, shouldRetry: ({ node, error }) => node === "MEMORY.GET" && error.status === "outcome_unknown" },
    onExecutionEvent(e) { events.push(e); } });
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5000) }) as [{ worker: WorkerAddress }];
    runtime.registerRemote({ address: ready.worker, capabilities: ["MEMORY.GET"], transportId: ipc.id });
    register(runtime, "backup", "backup");
    const started = once(child, "message", { signal: AbortSignal.timeout(5000) });
    const result = runtime.invoke("MEMORY.GET", { ids: ["wait-for-exit"] });
    await started;
    child.kill("SIGKILL");
    assert.equal((await result).status, "success");
    assert.ok(events.some(e => e.type === "worker.unavailable" && e.workerId === ready.worker.workerId));
    assert.ok(events.some(e => e.type === "recovery.decided" && e.nextWorkerId === "backup"));
  } finally { child.kill(); await exit; ipc.close(); await runtime.close(); }
});
