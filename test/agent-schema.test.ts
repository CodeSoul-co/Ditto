import assert from "node:assert/strict";
import test from "node:test";
import { glob, readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { agentSchema, validateAgent } from "../src/index.js";

test("official schema accepts every shipped Agent configuration and recursive expressions", async () => {
  const validate = new Ajv2020({ strict: false }).compile(agentSchema);
  let count = 0;
  for await (const path of glob(["agent_example.json", "examples/**/agent*.json", "docs/worker-api/examples/runtime/*.agent.json"])) {
    const definition = JSON.parse(await readFile(path, "utf8"));
    if (!definition.graphs) continue;
    assert.equal(validate(definition), true, `${path}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(validateAgent(definition), [], path);
    count++;
  }
  assert.ok(count >= 4);
  const source = { version: 1, id: "expressions", graphs: { main: { nodes: [{ id: "echo", type: "TEST.ECHO", input: {
    mapping: { $map: { items: [1, 2], value: { $op: "add", args: [{ $ref: "item" }, { $ref: "index" }] } } },
    literal: { $literal: { $custom: true } }, fallback: { $ref: "input.missing", default: null },
  } }] } } };
  assert.equal(validate(source), true, JSON.stringify(validate.errors));
  assert.deepEqual(validateAgent(source), []);
});

test("schema rejects unknown fields, invalid node variants, expression arities and incomplete Loops", () => {
  const validate = new Ajv2020({ strict: false }).compile(agentSchema);
  const node = { id: "echo", type: "TEST.ECHO", input: null };
  const source = { version: 1, id: "test", graphs: { main: { nodes: [node] } } };
  const invalid = [
    { ...source, extra: true },
    { ...source, loop: {} },
    { ...source, graphs: { other: source.graphs.main } },
    ...[
      { ...node, kind: "subgraph", graph: "main" },
      { ...node, input: { $op: "add", args: [1] } },
      { ...node, input: { $ref: "input.__proto__.x" } },
      { ...node, input: { $unknown: true } },
      { ...node, dependsOn: ["x", "x"] },
    ].map(node => ({ ...source, graphs: { main: { nodes: [node] } } })),
  ];
  for (const definition of invalid) {
    assert.equal(validate(definition), false, JSON.stringify(definition));
    assert.equal(validateAgent(definition).length, 1, JSON.stringify(definition));
  }
  // Cross-reference validity belongs to the compiler, not JSON Schema.
  const cyclic = { ...source, graphs: { main: { nodes: [{ ...node, dependsOn: ["echo"] }] } } };
  assert.equal(validate(cyclic), true);
  assert.equal(validateAgent(cyclic)[0]?.code, "CYCLIC_GRAPH");
});
