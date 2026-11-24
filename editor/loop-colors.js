const palette = ["#007369", "#ad4d18", "#3165ab", "#a33965", "#797013", "#007493", "#4b722b", "#915437"];
const key = (graph, range) => JSON.stringify([graph, range.entry, range.end]);

// Keep assignments in canvas history so reordering loops or switching languages
// doesn't change their meaning. The executable JSON contains only graph behavior.
export function assignLoopColors(graphs, previous = {}) {
  const keys = Object.entries(graphs).flatMap(([id, graph]) => (graph.loops || []).map((r) => key(id, r)));
  const colors = {},
    taken = new Set();
  for (const id of keys) {
    const slot = previous[id];
    if (Number.isSafeInteger(slot) && slot >= 0 && !taken.has(slot)) {
      colors[id] = slot;
      taken.add(slot);
    }
  }
  let next = 0;
  for (const id of keys)
    if (!Object.hasOwn(colors, id)) {
      while (taken.has(next)) next++;
      colors[id] = next;
      taken.add(next++);
    }
  return colors;
}
export function rangeColor(colors, graph, range) {
  const slot = colors[key(graph, range)];
  return palette[slot] ?? `hsl(${(slot * 137.508) % 360} 62% 34%)`;
}
