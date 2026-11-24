import { translator } from "./i18n.js";
import { INPUT, OUTPUT, graphEdges } from "./connections.js";
import { rangeMembers } from "./local-loops.js";
import { expressionLabel } from "./loop-map.js";
const $ = (id) => document.getElementById(id);
const svgNS = "http://www.w3.org/2000/svg";
const paths = {
  flow: "M5 4h6v5H5z M8 9v5m0-2h9v3 M5 15h6v5H5z M14 15h6v5h-6z",
  file: "M6 3h8l4 4v14H6z M14 3v5h4 M9 13h6m-6 3h4",
  folder: "M3 6h7l2 2h9v3 M3 6v13h16l3-9H7l-4 9",
  download: "M12 3v12m-5-5 5 5 5-5 M4 16v4h16v-4",
  plus: "M12 5v14m-7-7h14",
  minus: "M5 12h14",
  x: "M6 6l12 12M18 6 6 18",
  chevron: "m6 9 6 6 6-6",
  check: "m5 12 4 4L19 6",
  settings: "M3 7h7m4 0h7M3 17h11m4 0h3 M10 4v6m4 4v6",
  panel: "M3 4h18v16H3z M14 4v16",
  collapse: "M3 4h18v16H3z M14 4v16 M7 9l3 3-3 3",
  spark: "m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z M19 2v4m-2-2h4",
  code: "m7 7-5 5 5 5m10-10 5 5-5 5m-4-13-3 18",
  send: "m6 12 6-6 6 6m-6-6v13",
  undo: "m8 4-5 5 5 5M3 9h10a6 6 0 0 1 0 12",
  fit: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  stack: "m12 3 9 5-9 5-9-5z M3 12l9 5 9-5m-18 4 9 5 9-5",
  worker: "M5 5h14v14H5z M9 9h6v6H9z M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3",
  input: "M4 12h12m-5-5 5 5-5 5m6-13h3v16h-3",
  output: "M3 4h5v16H3m5-8h13m-5-5 5 5-5 5",
  edit: "m4 16 11-11 4 4L8 20l-5 1z M13 7l4 4",
  loop: "M4 10a8 8 0 0 1 13-5l3 3m0-5v5h-5M20 14a8 8 0 0 1-13 5l-3-3m0 5v-5h5",
};
export function icon(name) {
  const svg = document.createElementNS(svgNS, "svg"),
    path = document.createElementNS(svgNS, "path");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
export function graphModel(graph, t = translator("zh-CN")) {
  if (!graph.nodes.length) return { items: [], edges: [] };
  const items = [{ id: INPUT, title: t("input"), icon: "input", boundary: true }];
  for (const n of graph.nodes) {
    const sub = n.kind === "subgraph";
    items.push({
      id: n.id,
      title: n.id,
      sub,
      icon: sub ? "stack" : "worker",
      label: sub ? t("subgraph") + " / " + n.graph : n.type,
    });
  }
  items.push({ id: OUTPUT, title: t("output"), icon: "output", boundary: true });
  return { items, edges: graphEdges(graph) };
}
function arrange(items, edges, ranges) {
  const loopEnds = new Set(ranges.map((range) => range.end));
  const adjacent = new Map(items.map((n) => [n.id, []])),
    incoming = new Map(items.map((n) => [n.id, 0]));
  const depth = new Map(items.map((n) => [n.id, n.id === INPUT ? 0 : 1]));
  for (const { from, to } of edges) {
    adjacent.get(from).push(to);
    incoming.set(to, incoming.get(to) + 1);
  }
  const queue = items.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  for (let i = 0; i < queue.length; i++)
    for (const next of adjacent.get(queue[i])) {
      depth.set(next, Math.max(depth.get(next), depth.get(queue[i]) + 1));
      incoming.set(next, incoming.get(next) - 1);
      if (!incoming.get(next)) queue.push(next);
    }
  depth.set(OUTPUT, Math.max(...items.filter((n) => n.id !== OUTPUT).map((n) => depth.get(n.id))) + 1);
  const rows = new Map();
  for (const item of items) {
    const level = depth.get(item.id);
    if (!rows.has(level)) rows.set(level, []);
    rows.get(level).push(item);
  }
  const positions = new Map();
  const levels = [...rows].sort(([a], [b]) => a - b).map(([, row]) => row);
  // Keep long workflows legible at fit-to-canvas zoom. Keep siblings together
  // and continue the next set of stages in the adjacent column.
  const folded = levels.length >= 10 && items.length <= 80;
  if (folded) {
    const perColumn = Math.ceil(Math.sqrt(items.length * 1.6));
    let column = 0,
      count = 0,
      y = 0;
    for (const row of levels) {
      if (count && count + row.length > perColumn) {
        column++;
        count = y = 0;
      }
      for (const n of row) {
        positions.set(n.id, { x: column * 365 + (n.boundary ? 60 : 0), y });
        y += (n.boundary ? 42 : 85) + 52 + (loopEnds.has(n.id) ? 38 : 0);
      }
      count += row.length;
    }
  } else {
    let y = 0;
    for (const row of levels) {
      row.forEach((n, i) =>
        positions.set(n.id, { x: (i - (row.length - 1) / 2) * 310 - (n.boundary ? 146 : 266) / 2, y }),
      );
      y += Math.max(...row.map((n) => (n.boundary ? 42 : 85) + (loopEnds.has(n.id) ? 64 : 0))) + 53;
    }
  }
  return { positions, folded };
}
export function createCanvas({
  edit,
  openSubgraph,
  link,
  remember,
  menu,
  removeEdge,
  editRange,
  editCondition,
}) {
  const view = $("viewport"),
    world = $("world"),
    cards = $("cards"),
    lines = $("lines");
  let items = [],
    edges = [],
    positions = new Map(),
    folded = false,
    scale = 1,
    dx = 0,
    dy = 0,
    gesture = null,
    rendered = new Map(),
    paths = [],
    selected;
  function select(element) {
    selected?.classList.remove("selected");
    selected = element;
    selected?.classList.add("selected");
  }
  function transform() {
    world.style.transform = `translate(${dx}px,${dy}px) scale(${scale})`;
    $("zoom").textContent = Math.round(scale * 100) + "%";
  }
  function local(x, y) {
    const r = view.getBoundingClientRect();
    return { x: (x - r.left - dx) / scale, y: (y - r.top - dy) / scale };
  }
  function resizeZoom(factor) {
    const w = view.clientWidth / 2,
      h = view.clientHeight / 2,
      old = scale;
    scale = Math.max(0.15, Math.min(2.5, old * factor));
    dx = w - ((w - dx) * scale) / old;
    dy = h - ((h - dy) * scale) / old;
    transform();
  }
  function fit() {
    if (!view.clientWidth) return;
    if (!items.length) {
      scale = 1;
      dx = view.clientWidth / 2;
      dy = view.clientHeight / 2;
      transform();
      return;
    }
    const xs = [],
      ys = [];
    for (const item of items) {
      const p = positions.get(item.id);
      xs.push(p.x, p.x + (item.boundary ? 146 : 266));
      ys.push(p.y, p.y + (item.boundary ? 42 : 85));
    }
    for (const edge of edges) {
      if (edge.range !== undefined) {
        xs.push(Math.max(positions.get(edge.from).x, positions.get(edge.to).x) + 325 + edge.range * 10);
        ys.push(positions.get(edge.from).y + 122);
        if (positions.get(edge.from).x > positions.get(edge.to).x + 275) {
          ys.push(Math.min(...items.map((item) => positions.get(item.id).y)) - 45 - edge.range * 10);
          xs.push(positions.get(edge.to).x - 25);
        }
      }
      if (edge.label) {
        const { x, y, width, height } = edge.label.getBBox();
        xs.push(x, x + width);
        ys.push(y, y + height);
      }
    }
    const left = Math.min(...xs),
      top = Math.min(...ys),
      width = Math.max(...xs) - left,
      height = Math.max(...ys) - top;
    const heading = view.parentElement.querySelector(".canvas-heading");
    const topPad = folded
        ? Math.min(view.clientHeight * 0.3, heading.offsetTop + heading.offsetHeight + 10)
        : view.clientHeight < 450
          ? 45
          : 85,
      bottomPad = view.clientHeight < 450 ? 40 : 60;
    scale = Math.max(
      0.08,
      Math.min(1.15, (view.clientWidth - 50) / width, (view.clientHeight - topPad - bottomPad) / height),
    );
    dx = (view.clientWidth - width * scale) / 2 - left * scale;
    dy = topPad + (view.clientHeight - topPad - bottomPad - height * scale) / 2 - top * scale;
    transform();
  }
  function point(id, bottom) {
    const p = positions.get(id),
      boundary = id === INPUT || id === OUTPUT;
    return { x: p.x + (boundary ? 73 : 133), y: p.y + (bottom ? (boundary ? 42 : 85) : 0) };
  }
  function curve(a, b) {
    const bend = Math.max(22, Math.abs(b.y - a.y) * 0.48);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + bend}, ${b.x} ${b.y - bend}, ${b.x} ${b.y}`;
  }
  function wire(cls) {
    const p = document.createElementNS(svgNS, "path");
    p.setAttribute("class", "wire " + cls);
    lines.append(p);
    return p;
  }
  function paint() {
    for (const [id, node] of rendered) {
      const p = positions.get(id);
      node.style.transform = `translate(${p.x}px,${p.y}px)`;
    }
    const top = Math.min(...[...positions.values()].map((p) => p.y));
    edges.forEach(({ from, to, range }, i) => {
      let d;
      if (range === undefined) {
        const a = point(from, true),
          b = point(to, false);
        const across = b.x - a.x,
          offset = 14 + (i % 4) * 4;
        if (folded && across > 280) {
          const gutter = a.x + 164 + (i % 4) * 6;
          const before = b.x - 164;
          const rail = across > 500 ? top - offset - 8 : b.y - offset;
          d = `M ${a.x} ${a.y} v ${offset} H ${gutter} V ${rail} H ${across > 500 ? before : b.x}`;
          if (across > 500) d += ` V ${b.y - offset} H ${b.x}`;
          d += ` V ${b.y}`;
        } else if (folded && Math.abs(across) < 2 && b.y - a.y > 140) {
          const side = a.x - 151 - (i % 4) * 4;
          d = `M ${a.x} ${a.y} v ${offset} H ${side} V ${b.y - offset} H ${b.x} V ${b.y}`;
        } else d = curve(a, b);
      } else {
        const a = positions.get(from),
          b = positions.get(to);
        const right = Math.max(a.x, b.x) + 325 + range * 10;
        if (a.x > b.x + 275) {
          // Route a multi-column loop around the graph back to its entry.
          d = `M ${a.x + 266} ${a.y + 60} H ${right} V ${top - 45 - range * 10} H ${b.x - 25} V ${b.y + 22} H ${b.x}`;
        } else {
          d = `M ${a.x + 266} ${a.y + 60} C ${right} ${a.y + 64}, ${right} ${b.y + 12}, ${b.x + 266} ${b.y + 22}`;
        }
      }
      paths[i].forEach((p) => p.setAttribute("d", d));
      const label = edges[i].label;
      if (label) {
        const a = point(from, true),
          b = point(to, false);
        const left = b.x < a.x;
        label.setAttribute("text-anchor", left ? "end" : "start");
        const path = paths[i][0];
        const middle = path.getPointAtLength(path.getTotalLength() / 2);
        label.setAttribute("x", middle.x + (left ? -5 : 5));
        label.setAttribute("y", middle.y - 4);
      }
    });
  }
  function port(card, out, t) {
    const p = el("span", "port" + (out ? " out" : ""));
    p.dataset.port = out ? "out" : "in";
    p.title = t(out ? "portOut" : "portIn");
    card.append(p);
  }
  function display(graph, saved = {}, refit = true, t = translator("zh-CN"), styles = []) {
    gesture = null;
    select(null);
    ({ items, edges } = graphModel(graph, t));
    const ranges = graph.loops || [];
    ({ positions, folded } = arrange(items, edges, ranges));
    view.classList.toggle("folded", folded);
    const groups = ranges.map((r) => rangeMembers(graph, r.entry, r.end));
    for (const e of edges) {
      e.colors = e.reference
        ? []
        : styles.filter((_, i) => groups[i].has(e.from) && groups[i].has(e.to)).map((s) => s.color);
    }
    ranges.forEach((r, i) => edges.push({ from: r.end, to: r.entry, range: i }));
    rendered = new Map();
    cards.replaceChildren();
    lines.replaceChildren();
    styles.forEach(({ color }, i) => {
      const marker = document.createElementNS(svgNS, "marker");
      for (const [name, value] of Object.entries({
        id: "loop-arrow-" + i,
        viewBox: "0 0 8 8",
        refX: "7",
        refY: "4",
        markerWidth: "5",
        markerHeight: "5",
        orient: "auto",
      }))
        marker.setAttribute(name, value);
      const arrow = document.createElementNS(svgNS, "path");
      arrow.setAttribute("d", "M0 0 L8 4 L0 8 Z");
      arrow.setAttribute("fill", color);
      marker.append(arrow);
      lines.append(marker);
    });
    $("empty-canvas").hidden = items.length > 0;
    paths = edges.map((e, index) => {
      const group = document.createElementNS(svgNS, "g");
      group.dataset.edge = String(index);
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-haspopup", "menu");
      group.setAttribute(
        "aria-label",
        t(e.range !== undefined ? "loopRange" : e.reference ? "reference" : "dependency") +
          " · " +
          e.from +
          " → " +
          e.to,
      );
      const colors = e.range !== undefined ? [styles[e.range].color] : e.colors;
      const strokes = colors.length
        ? colors.map((color, i) => {
            const p = wire(e.range !== undefined ? "return-wire" : "repeated-wire");
            p.style.setProperty("--loop-color", color);
            if (colors.length > 1) {
              p.style.strokeDasharray = "8 " + 8 * (colors.length - 1);
              p.style.strokeDashoffset = String(-8 * i);
            }
            return p;
          })
        : [wire(e.reference ? "reference" : "")];
      const hit = wire("wire-hit");
      if (e.range !== undefined) strokes[0].setAttribute("marker-end", "url(#loop-arrow-" + e.range + ")");
      group.append(...strokes, hit);
      if (e.range === undefined) {
        group.ondblclick = () => editCondition(e);
        if (Object.hasOwn(e, "when")) {
          group.classList.add("conditional");
          const label = document.createElementNS(svgNS, "text");
          const description = expressionLabel(e.when);
          label.textContent = description.length > 44 ? description.slice(0, 43) + "…" : description;
          label.setAttribute("class", "edge-condition");
          group.setAttribute("aria-description", description);
          const title = document.createElementNS(svgNS, "title");
          title.textContent = description;
          label.append(title);
          label.onclick = () => editCondition(e);
          e.label = label;
          group.append(label);
        }
      } else group.ondblclick = () => editRange(e.range);
      lines.append(group);
      return [...strokes, hit];
    });
    for (const n of items) {
      const old = saved[n.id];
      if (old && Number.isFinite(old.x) && Number.isFinite(old.y)) positions.set(n.id, { ...old });
      const card = el("div", "node " + (n.boundary ? "boundary" : n.sub ? "subgraph" : "worker"));
      card.dataset.node = n.id;
      const membership = styles.filter((_, i) => groups[i].has(n.id));
      if (membership.length) {
        card.classList.add("in-loop");
        card.style.setProperty("--loop-color", membership[0].color);
        const bar = el("div", "loop-stripe");
        bar.setAttribute("aria-hidden", "true");
        for (const { color } of membership) {
          const segment = el("i");
          segment.style.backgroundColor = color;
          bar.append(segment);
        }
        card.append(bar);
      }
      const labels = el("div", "range-labels");
      ranges.forEach((r, i) => {
        if (r.end !== n.id) return;
        const b = el("button", "range-tag", styles[i].label);
        b.style.setProperty("--loop-color", styles[i].color);
        b.title = styles[i].label;
        b.onclick = () => editRange(i);
        labels.append(b);
      });
      if (labels.childElementCount) card.append(labels);
      card.tabIndex = 0;
      card.setAttribute("aria-haspopup", "menu");
      const symbol = el("span", "node-icon");
      symbol.append(icon(n.icon));
      card.append(symbol);
      const details = el("div", "details");
      details.title = [n.title, n.label].filter(Boolean).join(" · ");
      details.append(el("strong", "", n.title));
      if (n.label) details.append(el("small", "", n.label));
      card.append(details);
      if (!n.boundary) {
        const inspect = el("button", "inspect");
        inspect.title = t(n.sub ? "editCall" : "editNode") + " " + n.id;
        inspect.setAttribute("aria-label", inspect.title);
        inspect.append(icon("edit"));
        inspect.onclick = () => edit(n.id);
        if (n.sub) {
          const enter = el("button", "inspect");
          enter.title = t("editSubgraph") + " · " + graph.nodes.find((node) => node.id === n.id).graph;
          enter.setAttribute("aria-label", enter.title);
          enter.append(icon("stack"));
          enter.onclick = () => openSubgraph(n.id);
          card.append(enter);
        }
        card.append(inspect);
        card.ondblclick = (e) => {
          if (!e.target.closest("button")) (n.sub ? openSubgraph : edit)(n.id);
        };
      }
      if (n.id !== INPUT) port(card, false, t);
      if (n.id !== OUTPUT) port(card, true, t);
      cards.append(card);
      rendered.set(n.id, card);
    }
    paint();
    if (refit) fit();
  }
  function context(e, keyboard = false) {
    if (e.target.closest("button") && !e.target.closest(".node")) return;
    e.preventDefault();
    const element = e.target.closest("[data-node],[data-edge]") || view;
    select(element === view ? null : element);
    const rect = element.getBoundingClientRect();
    const x = keyboard ? rect.left + rect.width / 2 : e.clientX;
    const y = keyboard ? rect.top + rect.height / 2 : e.clientY;
    menu({ element, x, y, id: element.dataset.node, edge: edges[element.dataset.edge], point: local(x, y) });
  }
  view.oncontextmenu = (e) => context(e);
  view.onkeydown = (e) => {
    if (
      (e.shiftKey && e.key === "F10") ||
      e.key === "ContextMenu" ||
      (e.key === "Enter" && e.target.matches("[data-edge],[data-node]"))
    )
      context(e, true);
    else if (["Backspace", "Delete"].includes(e.key) && selected?.hasAttribute("data-edge")) {
      e.preventDefault();
      removeEdge(edges[selected.dataset.edge]);
    }
  };
  view.onpointerdown = (e) => {
    if (e.button !== 0 || e.target.closest("button") || gesture) return;
    const id = e.target.closest(".node")?.dataset.node,
      p = e.target.closest(".port");
    const edge = e.target.closest("[data-edge]");
    select(edge || e.target.closest(".node"));
    if (edge) {
      edge.focus();
      return;
    }
    gesture = {
      pointer: e.pointerId,
      id,
      x: e.clientX,
      y: e.clientY,
      origin: id ? { ...positions.get(id) } : { x: dx, y: dy },
      type: p ? "wire" : id ? "move" : "pan",
      reverse: p?.dataset.port === "in",
    };
    if (p) gesture.line = wire("pending");
    view.setPointerCapture(e.pointerId);
  };
  view.onpointermove = (e) => {
    if (!gesture || gesture.pointer !== e.pointerId) return;
    const g = gesture,
      x = e.clientX - g.x,
      y = e.clientY - g.y;
    if (g.type === "pan") {
      dx = g.origin.x + x;
      dy = g.origin.y + y;
      transform();
    } else if (g.type === "move") {
      positions.set(g.id, { x: g.origin.x + x / scale, y: g.origin.y + y / scale });
      paint();
    } else {
      const cursor = local(e.clientX, e.clientY);
      g.line.setAttribute(
        "d",
        g.reverse ? curve(cursor, point(g.id, false)) : curve(point(g.id, true), cursor),
      );
    }
  };
  function finish(e) {
    const g = gesture;
    if (!g || g.pointer !== e.pointerId) return;
    gesture = null;
    g.line?.remove();
    if (g.type === "move") remember(g.id, positions.get(g.id));
    if (g.type === "wire" && e.type === "pointerup") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".node")?.dataset.node;
      const from = g.reverse ? target : g.id,
        to = g.reverse ? g.id : target;
      if (
        from &&
        to &&
        from !== OUTPUT &&
        to !== INPUT &&
        (from !== to || Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6)
      )
        link(from, to);
    }
  }
  view.onpointerup = finish;
  view.onpointercancel = finish;
  view.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      resizeZoom(Math.exp(-e.deltaY * 0.002));
    },
    { passive: false },
  );
  $("plus").onclick = () => resizeZoom(1.2);
  $("minus").onclick = () => resizeZoom(1 / 1.2);
  $("fit").onclick = fit;
  new ResizeObserver(fit).observe(view);
  new ResizeObserver(() => {
    const panel = $("loop-map");
    view.style.bottom = panel.hidden
      ? "0"
      : Math.max(0, view.parentElement.clientHeight - panel.offsetTop) + "px";
  }).observe($("loop-map"));
  return { display };
}
