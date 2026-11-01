import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "redis";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { createTextWorker } from "@ditto-example/text-worker";
import { createTrace, runScenario } from "./host.ts";
import { startWorkerServer } from "./remote.mjs";

const exec = promisify(execFile), here = fileURLToPath(new URL(".", import.meta.url));
const directory = resolve(process.argv[2] ?? "task"), results = [];
const definition = async name => JSON.parse(await readFile(join(here, name, "agent.json"), "utf8"));
const starts = trace => trace.graphs.filter(e => e.status === "started");
const request = label => {
  const token = `audit-${randomUUID().slice(0, 8)}`;
  return { text: " A😀B ", mode: "research", prompt: `Count Unicode code points in exactly A😀B. Use token ${token}.`,
    memoryKey: `npm-${label}-${token}`, deliveryId: `${label}-${token}`, scope: { sessionId: `npm-${token}`, turnId: label }, token };
};
async function check(name, operation) {
  const started = Date.now(), evidence = await operation();
  results.push({ name, status: "passed", durationMs: Date.now() - started, ...evidence });
  console.log(JSON.stringify(results.at(-1)));
  await writeFile(join(directory, "results.json"), JSON.stringify({ status: "running", results }, null, 2));
}
async function successful(name, req) {
  const output = await runScenario(await definition(name), req, directory, createTextWorker());
  assert.equal(output.result.answer.trim(), "3");
  assert.equal(output.result.characters, 3);
  assert.equal(output.result.token, req.token);
  assert.deepEqual(output.trace.tools, [{ text: "A😀B", token: req.token }]);
  assert.equal(output.trace.modelCalls, 2);
  assert.equal(output.trace.searches, 1);
  assert.equal(output.trace.deliveries, 1);
  assert.equal((await readFile(join(directory, "answers", `${req.deliveryId}.md`), "utf8")).trim(), "3");
  return output;
}
async function absentDelivery(req) {
  assert.equal(await access(join(directory, "answers", `${req.deliveryId}.md`)).then(() => true, () => false), false);
}
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "guide.json"), await readFile(join(here, "single/guide.example.json")));
try {
  await check("single-graph-five-workers", async () => {
    const { trace } = await successful("single", request("single"));
    assert.deepEqual(starts(trace).map(e => e.graphId), ["main"]);
    assert.equal(starts(trace)[0].nodes.length, 13);
    return { workers: ["Context", "Memory", "Infer", "Interaction", "Retrieval"], nodes: 13, modelCalls: trace.modelCalls, nativeToolCalls: trace.tools.length };
  });
  await check("standalone-cli-without-third-party-extension", async () => {
    const req = JSON.parse(await readFile(join(here, "single/input.example.json"), "utf8")), input = join(directory, "cli-input.json");
    await writeFile(input, JSON.stringify(req));
    const code = `import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier, context, next) {if(specifier==='@ditto-example/text-worker') throw Error('Optional extension unavailable'); return next(specifier,context);}});
      process.argv=[process.execPath,${JSON.stringify(join(here, "cli.mjs"))},${JSON.stringify(join(here, "single/agent.json"))},${JSON.stringify(input)},${JSON.stringify(directory)}];
      await import(${JSON.stringify(new URL("cli.mjs", import.meta.url).href)});`;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", code], { timeout: 180_000 });
    assert.equal(JSON.parse(stdout).result.answer.trim(), "3");
    return { coreAndRetrievalOnly: true, jsonLoadedByCli: true };
  });
  await check("same-json-five-workers-over-http", async () => {
    const token = randomUUID(), req = request("http");
    const worker = await startWorkerServer(directory, { token, port: 0 });
    try {
      const input = join(directory, "http-input.json"), manifest = join(directory, "deployment.json");
      await writeFile(input, JSON.stringify(req)); await writeFile(manifest, JSON.stringify(worker.manifest));
      // Controller has no provider credentials, Redis URL or database connection.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DITTO_")));
      const run = value => exec(process.execPath, [join(here, "remote.mjs"), "run", join(here, "single/agent.json"), input, manifest], {
        env: { ...env, DITTO_TRANSPORT_HTTP_WORKER_TOKEN: value }, timeout: 180_000,
      });
      await assert.rejects(run("wrong-token"), /401/);
      assert.equal(worker.trace.modelCalls, 0);
      const { stdout } = await run(token), result = JSON.parse(stdout);
      assert.equal(result.answer.trim(), "3"); assert.equal(result.token, req.token);
      assert.equal(worker.trace.modelCalls, 2); assert.equal(worker.trace.tools.length, 1);
      assert.equal((await readFile(join(directory, "answers", `${req.deliveryId}.md`), "utf8")).trim(), "3");
      return { separateControllerProcess: true, realHttp: true, workers: worker.manifest.workers.length,
        unchangedJson: true, serverOwnedResources: true, authenticationChecked: true };
    } finally { await worker.close(); }
  });
  await check("third-party-npm-node-worker", async () => {
    const req = request("custom"), { result, trace } = await runScenario(await definition("custom"), req, directory, createTextWorker());
    assert.equal(result.answer, "Text: A😀B");
    assert.equal((await readFile(join(directory, "answers", `${req.deliveryId}.md`), "utf8")).trim(), result.answer);
    assert.equal(starts(trace)[0].nodes.length, 7);
    assert.equal(trace.modelCalls, 0); assert.equal(trace.searches, 0); assert.equal(trace.tools.length, 0);
    return { extension: "@ditto-example/text-worker", nodes: 7, augmentation: true, customNodeDefinitions: true };
  });
  const routed = request("routed");
  await check("main-router-multi-node-subgraphs", async () => {
    const { trace } = await successful("routed", routed);
    assert.deepEqual(starts(trace).map(e => e.graphId), ["main", "work"]);
    assert.equal(starts(trace)[1].nodes.length, 13);
    for (const prefix of ["research/", "act/", "finish/"]) assert.ok(starts(trace)[1].nodes.filter(n => n.startsWith(prefix)).length >= 3);
    return { graphs: ["main", "work"], subgraphs: ["research (5)", "act (3)", "finish (5)"], modelCalls: trace.modelCalls, nativeToolCalls: trace.tools.length };
  });
  await check("restart-expired-redis-recall-route", async () => {
    const client = createClient({ url: process.env.DITTO_WORKER_CONTEXT_REDIS_URL });
    client.on("error", () => {}); await client.connect();
    const key = `ditto:context:${contextScopeKey(routed.scope)}`;
    try {
      assert.equal(await client.exists(key), 1);
      await client.pExpire(key, 1); await new Promise(r => setTimeout(r, 20));
      assert.equal(await client.exists(key), 0);
    } finally { await client.quit(); }
    const recall = { ...routed, mode: "recall", deliveryId: `${routed.deliveryId}-recall` };
    const input = join(directory, "recall-input.json"); await writeFile(input, JSON.stringify(recall));
    const { stdout } = await exec(process.execPath, [join(here, "cli.mjs"), join(here, "routed/agent.json"), input, directory], { timeout: 30_000 });
    const { result, trace } = JSON.parse(stdout);
    assert.equal(result.answer.trim(), "3"); assert.equal(result.token, routed.token);
    assert.deepEqual(starts(trace).map(e => e.graphId), ["main", "recall"]);
    assert.equal(starts(trace)[1].nodes.length, 4);
    assert.equal(trace.modelCalls, 0); assert.equal(trace.searches, 0); assert.equal(trace.tools.length, 0);
    assert.equal((await readFile(join(directory, "answers", `${recall.deliveryId}.md`), "utf8")).trim(), "3");
    return { separateProcess: true, redisExpired: true, memory: "file SQLite", skippedResearchAndTools: true };
  });
  await check("json-only-loop-repetition", async () => {
    const d = await definition("custom"), req = request("repeat");
    d.loop = { entry: "run", maxIterations: 2, state: { round: 0 }, steps: {
      run: { graph: "main", input: { $ref: "input" },
        assign: { round: { $op: "add", args: [{ $ref: "state.round" }, 1] } },
        transitions: [{ when: { $op: "gte", args: [{ $ref: "state.round" }, 2] }, end: "completed" }, { next: "run" }],
      },
    }, output: { $ref: "result" } };
    const { result, trace } = await runScenario(d, req, directory, createTextWorker());
    assert.equal(result.answer, "Text: A😀B");
    assert.deepEqual(starts(trace).map(e => e.graphId), ["main", "main"]);
    assert.equal(trace.deliveries, 2);
    return { hostUnchanged: true, graphIterations: 2 };
  });
  await check("json-loop-budget", async () => {
    const d = await definition("routed"), req = request("budget"), trace = createTrace();
    d.loop.maxIterations = 1;
    await assert.rejects(runScenario(d, req, directory, createTextWorker(), trace), /iteration limit/i);
    assert.deepEqual(starts(trace).map(e => e.graphId), ["main"]);
    assert.equal(trace.tools.length + trace.modelCalls + trace.deliveries, 0);
    await absentDelivery(req);
    return { stoppedBeforeFunctionalGraph: true };
  });
  for (const [name, mutate, pattern] of [
    ["unregistered-worker", d => { d.deployment.workers.find(w => w.id === "text").use = "missing"; }, /worker/i],
    ["unknown-node", d => { d.graphs.main.nodes[0].type = "EXAMPLE.NPM.TEXT.MISSING"; }, /capab|node|worker/i],
    ["wrong-worker-binding", d => { d.deployment.bindings.main.normalized = "memory"; }, /capab|node|worker/i],
  ]) await check(name, async () => {
    const d = await definition("custom"), req = request("invalid"), trace = createTrace(); mutate(d);
    await assert.rejects(runScenario(d, req, directory, createTextWorker(), trace), pattern);
    assert.equal(trace.graphs.length + trace.deliveries + trace.tools.length, 0);
    await absentDelivery(req);
    return { rejectedBeforeGraph: true };
  });
  await check("tool-permission-denied", async () => {
    const d = await definition("single"), req = request("denied"), trace = createTrace();
    d.deployment.workers.find(w => w.id === "interaction").services = "no-tools";
    await assert.rejects(runScenario(d, req, directory, createTextWorker(), trace), /denied|sandbox|permission|allowed/i);
    assert.equal(trace.modelCalls, 1); assert.equal(trace.tools.length, 0); assert.equal(trace.deliveries, 0);
    await absentDelivery(req);
    return { rejectedBeforeToolExecution: true, downstreamStopped: true };
  });
  await check("sqlite-write-failure", async () => {
    const req = request("dbfail"), trace = createTrace(), db = new DatabaseSync(join(directory, "memory.sqlite"));
    try {
      db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'test storage unavailable'); END");
      await assert.rejects(runScenario(await definition("custom"), req, directory, createTextWorker(), trace), /requirement|storage|failed/i);
      assert.equal(trace.deliveries, 0); await absentDelivery(req);
    } finally { db.exec("DROP TRIGGER IF EXISTS reject_write"); db.close(); }
    return { realDatabaseError: true, noFalseDelivery: true };
  });
  await check("redis-unavailable", async () => {
    const previous = process.env.DITTO_WORKER_CONTEXT_REDIS_URL, trace = createTrace(), req = request("redisfail");
    try {
      process.env.DITTO_WORKER_CONTEXT_REDIS_URL = "redis://127.0.0.1:1";
      await assert.rejects(runScenario(await definition("custom"), req, directory, createTextWorker(), trace), /ECONNREFUSED|connect/i);
      assert.equal(trace.graphs.length + trace.deliveries, 0); await absentDelivery(req);
    } finally {
      if (previous === undefined) delete process.env.DITTO_WORKER_CONTEXT_REDIS_URL;
      else process.env.DITTO_WORKER_CONTEXT_REDIS_URL = previous;
    }
    return { noInMemoryFallback: true };
  });
  await writeFile(join(directory, "results.json"), JSON.stringify({ status: "passed", results }, null, 2) + "\n");
} catch (error) {
  await writeFile(join(directory, "results.json"), JSON.stringify({ status: "failed", error: error.message, results }, null, 2) + "\n");
  throw error;
}
