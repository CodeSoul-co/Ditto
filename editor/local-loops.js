import { createPicker } from "./picker.js";
import { expressionLabel } from "./loop-map.js";

const $ = (id) => document.getElementById(id);
function reachable(graph, start, reverse = false) {
  const adjacent = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const node of graph.nodes)
    for (const parent of node.dependsOn || []) {
      if (reverse) adjacent.get(node.id).push(parent);
      else adjacent.get(parent)?.push(node.id);
    }
  const seen = new Set([start]);
  for (const id of seen) for (const next of adjacent.get(id) || []) seen.add(next);
  return seen;
}
export function rangeMembers(graph, entry, end) {
  const forwards = reachable(graph, entry),
    backwards = reachable(graph, end, true);
  return new Set([...forwards].filter((id) => backwards.has(id)));
}
export function rangeLabel(range, t) {
  return (
    range.entry +
    (range.entry === range.end ? " ↺" : " → " + range.end) +
    " · ×" +
    range.maxIterations +
    (range.until === undefined ? "" : " · " + t("until") + " " + expressionLabel(range.until))
  );
}
export function initLocalLoops({ current, t, change, requireClean, notice }) {
  let body, draft, index, version, graph;
  const options = (ids) => ids.map((value) => ({ value, label: value }));
  const entry = createPicker($("range-entry"), (value) => {
    draft.entry = value;
    if (!reachable(body, value).has(draft.end)) draft.end = value;
    draw();
  });
  const end = createPicker($("range-end"), (value) => {
    draft.end = value;
    draw();
  });
  function draw() {
    const ids = body.nodes.map((n) => n.id),
      downstream = reachable(body, draft.entry);
    entry.set(options(ids), draft.entry);
    end.set(options(ids.filter((id) => downstream.has(id))), draft.end);
    $("range-path").textContent = [...rangeMembers(body, draft.entry, draft.end)].join(" · ");
  }
  function open(from, to, selected) {
    try {
      requireClean();
    } catch (e) {
      return notice(e.message);
    }
    const state = current();
    body = state.definition.graphs[state.graph];
    if (!body.nodes.length) return notice(t("needsNode"));
    index = selected ?? (body.loops || []).findIndex((r) => r.entry === from && r.end === to);
    const first = from || body.nodes[0].id;
    draft = structuredClone(body.loops?.[index] || { entry: first, end: to || first, maxIterations: 2 });
    version = state.rev;
    graph = state.graph;
    $("range-count").value = draft.maxIterations;
    $("range-until").value = draft.until === undefined ? "" : JSON.stringify(draft.until, null, 2);
    mode =
      draft.until === undefined
        ? "count"
        : draft.until?.$op === "eq" &&
            draft.until.args?.[0]?.$ref === "result" &&
            draft.until.args[1] === true
          ? "true"
          : "custom";
    showMode();
    $("range-error").textContent = "";
    $("range-remove").hidden = index < 0;
    draw();
    $("range-dialog").showModal();
  }
  let mode;
  const modes = createPicker($("range-mode"), (value) => {
    mode = value;
    showMode();
  });
  function showMode() {
    modes.set(
      ["count", "true", "custom"].map((value) => ({ value, label: t("range_" + value) })),
      mode,
    );
    $("range-expression").hidden = mode !== "custom";
  }
  async function save(remove) {
    try {
      if (current().rev !== version || current().graph !== graph) throw new Error(t("resend"));
      if (!remove) {
        draft.maxIterations = $("range-count").valueAsNumber;
        if (mode === "count") delete draft.until;
        else
          draft.until =
            mode === "true"
              ? { $op: "eq", args: [{ $ref: "result" }, true] }
              : JSON.parse($("range-until").value);
      }
      await change((next) => {
        const loops = (next.loops ??= []);
        if (remove) loops.splice(index, 1);
        else if (index >= 0) loops[index] = draft;
        else loops.push(draft);
        if (!loops.length) delete next.loops;
      });
      $("range-dialog").close();
    } catch (e) {
      $("range-error").textContent = e.message;
    }
  }
  $("range-form").onsubmit = (e) => {
    e.preventDefault();
    save(false);
  };
  $("range-remove").onclick = () => save(true);
  $("range-close").onclick = () => $("range-dialog").close();
  $("repeat-range").onclick = () => open();
  return { open };
}
