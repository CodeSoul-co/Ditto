import assert from "node:assert/strict";
import test from "node:test";
import { ContextError, createContext, createContextWorker, createDitto, type ContextItem } from "../src/index.js";

const budgetError = (e: unknown) => e instanceof ContextError && e.code === "BUDGET_UNSATISFIABLE";
const providerError = (e: unknown) => e instanceof ContextError && e.code === "INVALID_PROVIDER_OUTPUT";
const required: ContextItem = { id: "goal", content: { text: "keep my goal" }, source: { uri: "urn:user:goal" }, metadata: { protected: true } };
const pair: ContextItem[] = [
  { id: "call", content: "request", metadata: { callId: "c1" } },
  { id: "result", content: "receipt", metadata: { callId: "c1" } },
];

test("SELECT preserves each protection flag or fails an impossible item/token budget", async () => {
  for (const metadata of [{ protected: true }, { safety: true }, { currentGoal: true }, { pending: true }, { role: "system" }]) {
    const context = { items: [{ ...required, metadata }, { id: "optional", content: "evidence" }] };
    const client = createContext({ services: { tokenEstimator: { estimate: () => 2 } } });
    assert.deepEqual((await client.select({ context, purpose: "infer", limit: 1 })).selectedItemIds, ["goal"]);
    await assert.rejects(client.select({ context, purpose: "infer", limit: 0 }), budgetError);
    await assert.rejects(client.select({ context, purpose: "infer", maxTokens: 1 }), budgetError);
  }
  const tokenLimited = createContext({ policy: { maxTokens: 1 }, services: { tokenEstimator: { estimate: () => 2 } } });
  await assert.rejects(tokenLimited.select({ context: { items: [required] }, purpose: "infer", maxTokens: 10 }), budgetError);
  const client = createContext({ policy: { maxItems: 1 } });
  await assert.rejects(client.select({ context: { items: [required, { ...required, id: "goal2" }] }, purpose: "infer" }), budgetError);
});

test("SELECT keeps protected input alongside provider evidence and never splits tool groups", async () => {
  const client = createContext({ services: { selector: { select: async () => [{ id: "evidence", content: "retrieved" }] } } });
  const selected = await client.select({ context: { items: [required] }, purpose: "infer", strategy: { kind: "provider", name: "test" }, limit: 2 });
  assert.deepEqual(selected.selectedItemIds, ["goal", "evidence"]);
  const context = { items: [required, ...pair] };
  assert.deepEqual((await createContext().select({ context, purpose: "infer", limit: 2 })).selectedItemIds, ["goal"]);
  assert.equal((await createContext().select({ context, purpose: "infer", limit: 3 })).selectedItemIds.length, 3);
  const protectedPair = { items: [pair[0]!, { ...pair[1]!, metadata: { callId: "c1", pending: true } }] };
  await assert.rejects(createContext().select({ context: protectedPair, purpose: "infer", limit: 1 }), budgetError);
  const partial = createContext({ services: { selector: { select: async () => [pair[0]!] } } });
  await assert.rejects(partial.select({ context: { items: pair }, purpose: "infer", strategy: { kind: "provider", name: "test" } }), providerError);
});

test("providers cannot rewrite protected content, source or metadata", async () => {
  for (const changed of [
    { ...required, content: "changed goal" },
    { ...required, source: { uri: "urn:other" } },
    { ...required, metadata: {} },
  ]) {
    const client = createContext({ services: {
      selector: { select: async () => [changed] },
      compressor: { compress: async () => ({ items: [changed] }) },
    } });
    await assert.rejects(client.select({ context: { items: [required] }, purpose: "infer", strategy: { kind: "provider", name: "test" } }), providerError);
    await assert.rejects(client.compress({ context: { items: [required] } }), providerError);
  }
  const client = createContext({ services: { compressor: { compress: async () => ({ items: [structuredClone(required)] }) } } });
  assert.deepEqual((await client.compress({ context: { items: [required] } })).items, [required]);
});

test("provider input is immutable and protected tool receipts cannot be rewritten", async () => {
  const client = createContext({ services: { compressor: { compress: async input => {
    (input.context.items[0]!.content as { text: string }).text = "mutated";
    return input.context;
  } } } });
  await assert.rejects(client.compress({ context: { items: [required] } }), TypeError);
  assert.deepEqual(required.content, { text: "keep my goal" });
  const context = { items: [{ ...pair[0]!, metadata: { callId: "c1", pending: true } }, pair[1]!] };
  await assert.rejects(createContext({ services: { compressor: { compress: async () => ({ items: [context.items[0]!, { ...pair[1]!, content: "different receipt" }] }) } } }).compress({ context }), providerError);
});

test("memory selection still excludes private protected items; Worker reports budget failure", async () => {
  const client = createContext();
  const context = { items: [{ ...required, metadata: { protected: true, private: true } }] };
  assert.deepEqual((await client.select({ context, purpose: "memory" })).selectedItemIds, []);
  const runtime = createDitto({ workers: [createContextWorker()] });
  try {
    await assert.rejects(runtime.invoke("CONTEXT.SELECT", { context: { items: [required] }, purpose: "infer", limit: 0 }), /Protected Context/);
  } finally { await runtime.close(); }
});
