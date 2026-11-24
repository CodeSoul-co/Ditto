import { boolean, fail, fields, name, positive, record, type Expression } from "./agent-expression.js";
import type { GraphTask } from "./graph.js";
import { SKIPPED } from "./skipped.js";

type Inputs = Readonly<Record<string, unknown>>;
export type ValueResolver = (input: unknown, outputs: Inputs) => unknown;
export interface LocalLoopPlan {
  entry: string; end: string; maxIterations: number; members: Set<string>; path: string; index: number;
  until?: Expression;
}

/** A range contains exactly the nodes on dependency paths from entry to end. */
export function localLoops(raw: unknown, nodes: readonly { id: string; dependencies: readonly string[] }[],
  path: string, condition: (value: unknown, path: string) => Expression): LocalLoopPlan[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(path, "loops must be an array");
  const plans: LocalLoopPlan[] = [];
  for (const [index, value] of raw.entries()) {
    const where = path + "/" + index, item = record(value, where);
    fields(item, ["entry", "end", "maxIterations", "until"], where);
    const entry = name(item.entry, where + "/entry"), end = name(item.end, where + "/end");
    const descendants = new Set<string>();
    for (const node of nodes) if (node.id === entry || node.dependencies.some(id => descendants.has(id))) descendants.add(node.id);
    if (!descendants.has(end)) fail(where, "choose an existing dependency path from entry to end, or the same node for both");
    const members = new Set([end]);
    for (let n = nodes.length - 1; n >= 0; n--) {
      const node = nodes[n]!;
      if (members.has(node.id)) for (const dep of node.dependencies) if (descendants.has(dep)) members.add(dep);
    }
    for (const previous of plans) {
      const shared = [...members].filter(id => previous.members.has(id)).length;
      if (shared && (shared < Math.min(previous.members.size, members.size) || previous.members.size === shared && members.size === shared))
        fail(where, "loop ranges must be distinct and either nested or disjoint");
    }
    plans.push({ entry, end, path: where, index, members, maxIterations: positive(item.maxIterations, where + "/maxIterations"),
      ...(item.until !== undefined ? { until: condition(item.until, where + "/until") } : {}) });
  }
  return plans.sort((a, b) => a.members.size - b.members.size);
}

export interface ExpandedTask extends GraphTask { readonly owner: string }
export function repeatRange(tasks: ExpandedTask[], plan: LocalLoopPlan, depth: number,
  end: { leaves: readonly string[]; resolve: ValueResolver }, reserve: (count: number) => void): ExpandedTask[] {
  const { members, maxIterations, until } = plan;
  const body = tasks.filter(t => members.has(t.owner));
  reserve(body.length * (maxIterations - 1));
  const names = new Set(body.map(t => t.id));
  const key = (id: string, round: number) => names.has(id) && round !== maxIterations - 1 ? id + "#" + depth + "." + plan.index + "." + round : id;
  // An outgoing dependency observes the completed range, even when it reads
  // a node before the range's end. Its data binding still sees the same value.
  const output = tasks.filter(t => !members.has(t.owner)).map(t => t.dependencies.some(id => names.has(id))
    ? { ...t, dependencies: [...new Set([...t.dependencies, ...end.leaves])] } : t);
  const mapped = (ids: readonly string[], values: Inputs, round: number) =>
    Object.fromEntries(ids.map(id => [id, values[key(id, round)]]));
  let edgeCount = 0;
  for (let round = 0; round < maxIterations; round++) {
    const previous = end.leaves.map(id => key(id, round - 1));
    for (const t of body) {
      const dependencies = t.dependencies.map(id => key(id, round));
      if (round) {
        for (const id of previous) dependencies.push(id);
        if (until) dependencies.push(key(t.id, round - 1));
      }
      edgeCount += dependencies.length;
      if (edgeCount > 500_000) fail(plan.path, "expanded loop dependency limit exceeded", "LIMIT_EXCEEDED");
      output.push({ ...t, id: key(t.id, round), bindingId: t.bindingId ?? t.id, dependencies: [...new Set(dependencies)],
        bind: (input, values) => t.bind(input, mapped(t.dependencies, values, round)),
        ...((until && round > 0) || t.reuse ? { reuse(input: unknown, values: Inputs) {
          // A completed range carries forward every leaf. With a pure result/config
          // predicate its end value stays stable on all remaining rounds.
          if (until && round) {
            const result = end.resolve(input, mapped(end.leaves, values, round - 1));
            if (result !== SKIPPED && boolean(until({ result }), plan.path + "/until"))
              return { value: values[key(t.id, round - 1)] };
          }
          return t.reuse?.(input, mapped(t.dependencies, values, round));
        } } : {}),
      });
    }
  }
  return output;
}

export function orderLoopTasks<T extends GraphTask>(tasks: readonly T[]): T[] {
  const children = new Map<string, T[]>(), pending = new Map<string, number>();
  const ready = tasks.filter(t => !t.dependencies.length);
  for (const task of tasks) {
    pending.set(task.id, task.dependencies.length);
    for (const id of task.dependencies) {
      const list = children.get(id) ?? [];
      list.push(task); children.set(id, list);
    }
  }
  for (let i = 0; i < ready.length; i++) for (const child of children.get(ready[i]!.id) ?? []) {
    const left = pending.get(child.id)! - 1;
    if (!left) ready.push(child);
    pending.set(child.id, left);
  }
  if (ready.length !== tasks.length) fail("/graphs", "loop ranges introduce conflicting execution order");
  return ready;
}
