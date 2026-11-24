import { appendNode } from "./connections.js";

export function nextName(base, taken) {
  const names = new Set(taken);
  let id = base;
  for (let n = 2; names.has(id); n++) id = base + n;
  return id;
}
export function newSubgraph() {
  return { nodes: [] };
}
export function insertCall(definition, parent, target, useInput = false) {
  const nodes = definition.graphs[parent].nodes;
  appendNode(definition.graphs[parent], {
    id: nextName(
      target,
      nodes.map((n) => n.id),
    ),
    kind: "subgraph",
    graph: target,
    input: useInput ? { $ref: "input" } : {},
  });
}
export function newLoop() {
  return {
    entry: "main",
    maxIterations: 2,
    state: { round: 0 },
    steps: {
      main: {
        graph: "main",
        input: { $ref: "input" },
        assign: { round: { $op: "add", args: [{ $ref: "state.round" }, 1] } },
        transitions: [
          { when: { $op: "lt", args: [{ $ref: "state.round" }, 2] }, next: "main" },
          { end: "completed" },
        ],
      },
    },
    output: { $ref: "result" },
  };
}
export function appendStep(loop, after, graph) {
  const id = nextName(graph, Object.keys(loop.steps));
  const transitions = loop.steps[after].transitions;
  const previous = transitions[transitions.length - 1];
  transitions[transitions.length - 1] = { next: id };
  loop.steps[id] = { graph, input: { $ref: "input" }, transitions: [previous] };
  loop.maxIterations += 1;
  return id;
}
