export const INPUT = "@input",
  OUTPUT = "@output";
const sourcePath = (from) => (from === INPUT ? "input" : "nodes." + from);

function unbind(value, path) {
  if (!value || typeof value !== "object" || Object.hasOwn(value, "$literal")) return value;
  if (value.$ref === path || value.$ref?.startsWith(path + ".")) return unbind(value.default ?? null, path);
  if (Array.isArray(value)) return value.map((v) => unbind(v, path));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unbind(v, path)]));
}

export function outputMapping(graph) {
  return graph.output === undefined
    ? Object.fromEntries(graph.nodes.map((n) => [n.id, { $ref: sourcePath(n.id) }]))
    : graph.output;
}
export function withoutGraphInput(value) {
  return unbind(value, "input");
}
export function appendNode(graph, node) {
  // An omitted output projects every node, including later additions. Keep the
  // existing projection and let the user choose where the new node connects.
  if (graph.nodes.length && graph.output === undefined) graph.output = outputMapping(graph);
  graph.nodes.push(node);
}
export function disconnect(graph, { from, to }) {
  const path = sourcePath(from);
  if (to === OUTPUT) {
    if (graph.output === undefined) {
      graph.output = outputMapping(graph);
      delete graph.output[from];
    } else graph.output = unbind(graph.output, path);
  } else {
    const node = graph.nodes.find((n) => n.id === to);
    node.input = unbind(node.input, path);
    if (from !== INPUT && node.dependsOn) node.dependsOn = node.dependsOn.filter((id) => id !== from);
  }
}
export function bindingSlots(value) {
  const slots = [];
  function visit(current, path) {
    slots.push({ path, vacant: current == null });
    if (!current || typeof current !== "object" || Object.keys(current).some((k) => k.startsWith("$")))
      return;
    for (const [key, child] of Object.entries(current)) visit(child, [...path, key]);
  }
  visit(value, []);
  return slots;
}
export function connectBinding(graph, from, to, path) {
  const node = to === OUTPUT ? graph : graph.nodes.find((n) => n.id === to);
  const key = to === OUTPUT ? "output" : "input";
  const ref = { $ref: sourcePath(from) };
  if (!path.length) node[key] = ref;
  else {
    if (to === OUTPUT) graph.output = outputMapping(graph);
    let parent = node[key];
    for (const part of path.slice(0, -1)) parent = parent[part];
    parent[path.at(-1)] = ref;
  }
}

function refs(value, result = new Set()) {
  if (!value || typeof value !== "object" || Object.hasOwn(value, "$literal")) return result;
  if (typeof value.$ref === "string") result.add(value.$ref);
  for (const v of Object.values(value)) refs(v, result);
  return result;
}
export function graphEdges(graph) {
  const edges = [];
  for (const n of graph.nodes) {
    for (const from of n.dependsOn || []) edges.push({ from, to: n.id });
    if ([...refs(n.input)].some((path) => path === "input" || path.startsWith("input.")))
      edges.push({ from: INPUT, to: n.id, reference: true });
  }
  const outputs =
    graph.output === undefined ? graph.nodes.map((n) => "nodes." + n.id) : [...refs(graph.output)];
  const sources = new Set(
    outputs.flatMap((path) =>
      path === "nodes"
        ? graph.nodes.map((n) => n.id)
        : path.startsWith("nodes.")
          ? [path.split(".")[1]]
          : path === "input" || path.startsWith("input.")
            ? [INPUT]
            : [],
    ),
  );
  for (const from of sources) edges.push({ from, to: OUTPUT, reference: true });
  if (graph.conditions?.length) {
    const byEdge = new Map(edges.map((edge) => [edge.from + "/" + edge.to, edge]));
    for (const { from, to, when } of graph.conditions) {
      const edge = byEdge.get(from + "/" + to);
      if (edge) edge.when = when;
    }
  }
  return edges;
}

export function pruneConditions(graph) {
  if (!graph.conditions?.length) return;
  const existing = new Set(graphEdges(graph).map((e) => e.from + "/" + e.to));
  graph.conditions = graph.conditions.filter(({ from, to }) => existing.has(from + "/" + to));
  if (!graph.conditions.length) delete graph.conditions;
}

export function setCondition(graph, { from, to }, when) {
  const conditions = (graph.conditions || []).filter((c) => c.from !== from || c.to !== to);
  if (when !== undefined) conditions.push({ from, to, when });
  if (conditions.length) graph.conditions = conditions;
  else delete graph.conditions;
}
