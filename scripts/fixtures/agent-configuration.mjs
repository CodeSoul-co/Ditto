/** Configuration plumbing acceptance against installed public npm exports; no model or database substitute. */
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import { setTimeout } from "node:timers/promises";
import { createAgent, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { defineWorker } from "@codesoul-co/ditto/worker";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";

const previous = await readFile("ditto.yaml").catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
try {
await writeFile("ditto.yaml", `runtime:
  timeoutMs: 12345
  graphConcurrency: 1
  loopMaxIterations: 1
workers:
  context:
    policy:
      maxItems: 1
  infer:
    generation:
      maxTokens: 37
  memory:
    queryLimit: 7
`);
const env = parseEnv("DITTO_RUNTIME_ENV=test\nDITTO_SHARED_SANDBOX_ALLOW_TOOLS=ping\n");
Object.assign(process.env, env);
const template = JSON.parse(await readFile("agent.json", "utf8"));
template.config.repetitions = 2;
const context = await createAgent(template, { workers: { context: createContextWorker() } });
const config = context.runtime.services.config;
assert.equal(config.timeoutMs, 12345);
assert.equal(config.infer.generation.maxTokens, 37);
assert.equal(config.memory.queryLimit, 7);
try {
  const iterations = [];
  assert.equal(await context.run("hello", { onGraph: e => { if (e.status === "started") iterations.push(e); } }), "hello");
  assert.equal(iterations.length, 2); // Explicit agent Loop budget overrides the Runtime fallback of one.
} finally { await context.close(); }
template.graphs["load-context"].nodes[0].input.sources.push({ role: "user", content: "second" });
const limited = await createAgent(template, { workers: { context: createContextWorker() } });
try { await assert.rejects(limited.run("hello"), /limit/i); }
finally { await limited.close(); }

let active = 0, maximum = 0, calls = 0;
const definition = { version: 1, id: "configuration-check", graphs: { main: { nodes: [
  ...["a", "b"].map(id => ({ id, type: "EXAMPLE.CONFIG.PROBE", input: {} })),
  { id: "tool", type: "INTERACTION.ACT.TOOL", dependsOn: ["a", "b"], input: { call: { id: "call", name: "ping", arguments: {} } } },
], output: { $ref: "nodes.tool.status" } } } };
const workers = {
  probe: defineWorker({ type: "probe", nodes: { "EXAMPLE.CONFIG.PROBE": async (_input, ctx) => {
    assert.equal(ctx.services.config.environment, "test");
    assert.equal(ctx.services.config.timeoutMs, 12345);
    active++; maximum = Math.max(maximum, active);
    try { await setTimeout(5); return {}; } finally { active--; }
  } } }),
  tool: createInteractionWorker({ tools: [{ name: "ping", effects: [], requiresApproval: false,
    inputSchema: { type: "object", properties: {} }, validate() {},
    async execute() { calls++; return { status: "success", content: "pong" }; },
  }] }),
};
const agent = await createAgent(definition, { workers });
try { assert.equal(await agent.run({}), "success"); assert.equal(maximum, 1); assert.equal(calls, 1); }
finally { await agent.close(); }
const denied = await createAgent(definition, {
  config: loadRuntimeConfigFile("ditto.yaml", { ...env, DITTO_SHARED_SANDBOX_ALLOW_TOOLS: "" }), workers,
});
try { await assert.rejects(denied.run({}), /denied|permission|allowed/i); assert.equal(calls, 1); }
finally { await denied.close(); }

} finally {
  if (previous) await writeFile("ditto.yaml", previous);
  else await rm("ditto.yaml", { force: true });
}
