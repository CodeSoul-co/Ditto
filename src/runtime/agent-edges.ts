import { boolean, fail, fields, record, type Expression } from "./agent-expression.js";

export interface AgentEdgeCondition {
  readonly from: string;
  readonly to: string;
  readonly when: import("../contracts/common.js").JsonValue;
}
export type EdgeGate = (input: unknown, result: unknown) => boolean;
export function edgeGates(raw: unknown, path: string, exists: (from: string, to: string) => boolean,
  compile: (value: unknown, path: string) => Expression): Map<string, Map<string, EdgeGate>> {
  const incoming = new Map<string, Map<string, EdgeGate>>();
  if (raw === undefined) return incoming;
  if (!Array.isArray(raw)) fail(path, "conditions must be an array");
  for (const [index, entry] of raw.entries()) {
    const where = path + "/" + index, edge = record(entry, where);
    fields(edge, ["from", "to", "when"], where);
    const { from, to } = edge;
    if (typeof from !== "string" || typeof to !== "string" || !exists(from, to)) fail(where, "condition must name an existing connection");
    if (!Object.hasOwn(edge, "when")) fail(where, "when is required");
    const gates = incoming.get(to) ?? new Map<string, EdgeGate>();
    if (gates.has(from)) fail(where, "duplicate condition for this connection");
    const evaluate = compile(edge.when, where + "/when");
    gates.set(from, (input, result) => boolean(evaluate({ input, result }), where + "/when"));
    incoming.set(to, gates);
  }
  return incoming;
}
