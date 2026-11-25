import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createDitto, createHttpTransport, createIpcTransport, defineWorker, graph,
  NoWorkerAvailableError, TransportError, type WorkerAddress, type InvocationEnvelope,
} from "../src/index.js";

test("real child IPC and HTTP run one graph with route bindings, correlation and execution scope", async () => {
  const token = randomUUID();
  const child = fork(new URL("./fixtures/runtime-worker.js", import.meta.url), [], {
    env: { ...process.env, TEST_WORKER_TOKEN: token }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  let ipc: ReturnType<typeof createIpcTransport> | undefined;
  let runtime: ReturnType<typeof createDitto> | undefined;
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5000) }) as [{ worker: WorkerAddress; url: string }];
    ipc = createIpcTransport({ id: "ipc", channel: child, timeoutMs: 1000 });
    const http = createHttpTransport({ id: "http", url: ready.url, token });
    // Separate directory IDs on the caller are unnecessary: the same remote address can
    // be registered in separate runtimes using the desired channel.
    runtime = createDitto({ hostId: "same-host", transports: [ipc, http] });
    runtime.registerRemote({ address: ready.worker, capabilities: ["MEMORY.GET"], transportId: ipc.id, concurrency: 4 });
    runtime.register(defineWorker({ type: "CONTEXT", nodes: {
      "CONTEXT.LOAD": async ({ sources }) => ({ items: (sources ?? []).map((s, i) => ({ id: String(i), content: String("content" in s ? s.content : s.uri) })) }),
    } }), "local-context");
    const plan = graph<string>("remote-graph")
      .node("read", "MEMORY.GET", [], id => ({ ids: [id] }))
      .node("load", "CONTEXT.LOAD", ["read"], (_input, { read }) => ({ sources: [{ role: "user", content: String(read.output![0]!.content) }] }));
    for (const transport of [ipc, http]) {
      if (transport === http) {
        await runtime.close();
        runtime = createDitto({ hostId: "other-host", transports: [http] });
        runtime.registerRemote({ address: ready.worker, capabilities: ["MEMORY.GET"], transportId: http.id });
        runtime.register(defineWorker({ type: "CONTEXT", nodes: {
          "CONTEXT.LOAD": async ({ sources }) => ({ items: (sources ?? []).map((s, i) => ({ id: String(i), content: String("content" in s ? s.content : s.uri) })) }),
        } }), "local-context");
      }
      const result = await runtime.run(plan, "hello", { workers: { read: ready.worker.workerId, load: "local-context" } });
      const data = JSON.parse(result.load.items[0]!.content as string);
      assert.equal(data.pid, child.pid); assert.notEqual(data.pid, process.pid);
      assert.deepEqual(data.ids, ["hello"]); assert.equal(data.execution.graphId, "remote-graph");
      assert.equal(data.execution.nodeId, "read"); assert.ok(data.execution.runId);
    }
    const envelope = (id = randomUUID()): InvocationEnvelope => ({ id, node: "MEMORY.GET", target: ready.worker,
      payload: { kind: "inline", value: { ids: ["slow"] } } });
    const controller = new AbortController();
    const cancelled = ipc.invoke(envelope(), { signal: controller.signal });
    controller.abort(new Error("caller cancelled"));
    await assert.rejects(cancelled, /caller cancelled/);
    const timed = createIpcTransport({ id: "short", channel: child, timeoutMs: 1 });
    try {
      await assert.rejects(timed.invoke(envelope()), { code: "TIMEOUT", status: "outcome_unknown" });
      assert.equal(timed.available, true);
    } finally { timed.close(); }
    const unauthorized = createHttpTransport({ id: "denied", url: ready.url, token: "wrong" });
    await assert.rejects(unauthorized.invoke(envelope()), { code: "REMOTE_ERROR", status: "outcome_unknown" });
    const small = createHttpTransport({ id: "small", url: ready.url, token, maxBodyBytes: 1 });
    await assert.rejects(small.invoke(envelope()), { code: "INVALID_REQUEST", status: "not_sent" });
    const jobs = [ipc.invoke(envelope()), ipc.invoke(envelope())];
    const settled = Promise.allSettled(jobs);
    ipc.close();
    for (const result of await settled) {
      assert.ok(result.status === "rejected" && result.reason instanceof TransportError);
      assert.equal(result.reason.code, "CHANNEL_CLOSED");
      assert.equal(result.reason.status, "outcome_unknown");
    }
    await assert.rejects(ipc.invoke(envelope()), { code: "CHANNEL_CLOSED", status: "not_sent" });
  } finally {
    await runtime?.close(); ipc?.close();
    if (child.connected) child.send("shutdown");
    const timer = setTimeout(() => child.kill(), 3000);
    try { await exit; } finally { clearTimeout(timer); }
  }
});

test("worker exit excludes its IPC route, preserves pinned routing and leaves in-flight recovery to the caller", async () => {
  const child = fork(new URL("./fixtures/runtime-worker.js", import.meta.url), [], {
    env: { ...process.env, TEST_WORKER_TOKEN: randomUUID() }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  const ipc = createIpcTransport({ id: "A", channel: child });
  let callsToB = 0;
  const runtime = createDitto({ transports: [ipc, { id: "B", async invoke(envelope) {
    callsToB++;
    return { invocationId: envelope.id, payload: { kind: "inline", value: { executionId: "B", node: "MEMORY.GET", status: "success", output: [] } } };
  } }] });
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5000) }) as [{ worker: WorkerAddress }];
    const a = runtime.registerRemote({ address: ready.worker, capabilities: ["MEMORY.GET"], transportId: ipc.id });
    runtime.registerRemote({ address: { ...ready.worker, workerId: "B" }, capabilities: ["MEMORY.GET"], transportId: "B" });
    const started = once(child, "message", { signal: AbortSignal.timeout(5000) });
    const failed = assert.rejects(runtime.invoke("MEMORY.GET", { ids: ["wait-for-exit"] }), (error: unknown) =>
      error instanceof TransportError && ["CHANNEL_CLOSED", "WORKER_EXITED"].includes(error.code)
      && error.status === "outcome_unknown" && error.workerId === a.address.workerId && !!error.invocationId);
    assert.equal((await started)[0], "started");
    child.kill("SIGKILL");
    await exit;
    await failed;
    a.setAvailable(true);
    assert.deepEqual(runtime.workers().map(worker => worker.available), [false, true]);
    await assert.rejects(runtime.invoke("MEMORY.GET", {}, { workerId: a.address.workerId }), NoWorkerAvailableError);
    assert.equal(callsToB, 0);
    await runtime.invoke("MEMORY.GET", {});
    assert.equal(callsToB, 1);
    await assert.rejects(ipc.invoke({ id: "later", target: a.address, node: "MEMORY.GET", payload: { kind: "inline", value: {} } }),
      { code: "WORKER_EXITED", status: "not_sent", invocationId: "later", workerId: a.address.workerId });
  } finally { child.kill(); await exit; ipc.close(); await runtime.close(); }
});

test("router prefers local, same-host IPC, then cross-host HTTP without changing the graph", async () => {
  const selected: string[] = [];
  const runtime = createDitto({ hostId: "host", transports: [{ id: "fixture", async invoke(envelope) {
    selected.push(envelope.target.workerId);
    return { invocationId: envelope.id, payload: { kind: "inline", value: { items: [] } } };
  } }] });
  const local = runtime.register(defineWorker({ type: "CONTEXT", nodes: {
    "CONTEXT.LOAD": async () => { selected.push("local"); return { items: [] }; },
  } }));
  const same = runtime.registerRemote({ address: { workerId: "same", workerType: "CONTEXT", hostId: "host", processId: "other" },
    capabilities: ["CONTEXT.LOAD"], transportId: "fixture" });
  runtime.registerRemote({ address: { workerId: "remote", workerType: "CONTEXT", hostId: "other", processId: "other" },
    capabilities: ["CONTEXT.LOAD"], transportId: "fixture" });
  const plan = graph<void>().node("load", "CONTEXT.LOAD", [], () => ({ sources: [] }));
  try {
    await runtime.run(plan, undefined); local.setAvailable(false);
    await runtime.run(plan, undefined); same.setAvailable(false);
    await runtime.run(plan, undefined);
    assert.deepEqual(selected, ["local", "same", "remote"]);
  } finally { await runtime.close(); }
});

test("HTTP transport rejects invalid IDs and deadlines before opening a connection", () => {
  const options = { id: "worker", token: "token", url: "http://127.0.0.1:1/ditto/invoke" };
  for (const timeoutMs of [0, -1, Infinity, 1.5, 2147483648]) assert.throws(() => createHttpTransport({ ...options, timeoutMs }));
  assert.throws(() => createHttpTransport({ ...options, id: "" }));
});

test("HTTP reference payloads use the shared ArtifactStore and remain explicitly releasable", async () => {
  const { createServer } = await import("node:http");
  const { InMemoryArtifactStore, createWorkerHttpHandler } = await import("../src/index.js");
  const storage = new InMemoryArtifactStore();
  const references: { uri: string }[] = [];
  const artifacts = {
    async put(value: unknown) { const reference = await storage.put(value); references.push(reference); return reference; },
    get: (reference: { uri: string }) => storage.get(reference),
    delete: (reference: { uri: string }) => storage.delete(reference),
  };
  const receiver = createDitto({ hostId: "receiver", artifacts, inlineLimitBytes: 8 });
  const worker = receiver.register(defineWorker({ type: "MEMORY", nodes: {
    "MEMORY.GET": async input => ({ executionId: "artifact-read", node: "MEMORY.GET", status: "success", output: [{ id: "doc", content: input.ids![0] }] }),
  } }));
  const server = createServer(createWorkerHttpHandler(receiver, { token: "artifact-fixture" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const transport = createHttpTransport({ id: "artifact", token: "artifact-fixture", url: `http://127.0.0.1:${address.port}/ditto/invoke` });
  const sender = createDitto({ hostId: "sender", artifacts, inlineLimitBytes: 8, transports: [transport] });
  sender.registerRemote({ address: worker.address, capabilities: ["MEMORY.GET"], transportId: transport.id });
  try {
    const text = "中文 payload ".repeat(100);
    const result = await sender.invoke("MEMORY.GET", { ids: [text] });
    assert.equal(result.output?.[0]?.content, text); assert.equal(references.length, 2);
    for (const reference of references) {
      assert.equal(await artifacts.delete(reference), true);
      assert.equal(await artifacts.delete(reference), false);
      await assert.rejects(artifacts.get(reference), /Artifact not found/);
    }
  } finally {
    await sender.close(); await receiver.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
