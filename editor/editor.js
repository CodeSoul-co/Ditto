import { initStructure } from "./structure-dialog.js";
import { initLocalLoops, rangeMembers, rangeLabel } from "./local-loops.js";
import { initEdgeDialog } from "./edge-dialog.js";
import { assignLoopColors, rangeColor } from "./loop-colors.js";
import { createCanvasHistory, blankDefinition } from "./canvases.js";
import { createContextMenu, initCanvasLibrary } from "./canvas-menus.js";
import {
  INPUT,
  OUTPUT,
  disconnect,
  outputMapping,
  bindingSlots,
  connectBinding,
  appendNode,
  withoutGraphInput,
  pruneConditions,
} from "./connections.js";
import { drawLoopMap } from "./loop-map.js";
import { nextName } from "./structure.js";
import { createPicker } from "./picker.js";
import { initModelDialog } from "./model-dialog.js";
import { initImportDialog } from "./import-dialog.js";
import { createDiscussions } from "./discussions.js";
import { initSidebar } from "./sidebar.js";
import { workers, makeNode } from "./catalog.js";
import { translator } from "./i18n.js";
import { createCanvas, el, icon } from "./canvas.js";

const $ = (id) => document.getElementById(id),
  pretty = (value) => JSON.stringify(value, null, 2);
let locale = "en";
const preference = "ditto-editor:language";
try {
  if (localStorage.getItem(preference) === "zh-CN") locale = "zh-CN";
} catch {
  /* Storage is optional. */
}
let t = translator(locale);
let installed = new Set();
let selectedWorker = workers[0];
const catalog = new Map(workers.flatMap((worker) => worker.nodes.map((node) => [node.type, node])));
function translatePage() {
  document.documentElement.lang = locale;
  for (const node of document.querySelectorAll("[data-text]")) node.textContent = t(node.dataset.text);
  for (const [key, attribute] of [
    ["aria", "aria-label"],
    ["title", "title"],
    ["placeholder", "placeholder"],
  ]) {
    for (const node of document.querySelectorAll("[data-" + key + "]"))
      node.setAttribute(attribute, t(node.dataset[key]));
  }
  const toggle = $("language");
  toggle.textContent = locale === "en" ? "中文" : "English";
  toggle.lang = locale === "en" ? "zh-CN" : "en";
  toggle.setAttribute("aria-label", locale === "en" ? "切换到中文" : "Switch to English");
}
for (const i of document.querySelectorAll("[data-icon]")) i.append(icon(i.dataset.icon));
let definition,
  filename,
  fileHandle,
  graph = "main",
  layouts = {},
  loopColors = {},
  undo = [],
  documentKey,
  rev = 0,
  canvasId,
  history,
  additionPoint,
  dialogNode,
  noticeTimer;
const raw = $("raw"),
  dialog = $("node-dialog");
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    headers: { "Accept-Language": locale, ...(body && { "content-type": "application/json" }) },
    ...(body && { method: "POST", body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || t("requestFailed"));
  return result;
}
function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("notice").hidden = true), 5000);
}
function persist() {
  try {
    history.write({ id: canvasId, definition, filename, graph, layouts, documentKey, loopColors });
    return true;
  } catch {
    notice(t("storageFailed"));
    return false;
  }
}
function dirty() {
  return definition && raw.value !== pretty(definition);
}
function requireClean() {
  if (dirty()) throw new Error(t("dirty"));
}
function commit(next, refit = true, placement, reset = false) {
  if (JSON.stringify(next) === JSON.stringify(definition)) return;
  undo.push({ definition, layouts: structuredClone(layouts), graph, loopColors });
  if (undo.length > 30) undo.shift();
  definition = next;
  if (reset) {
    layouts = {};
    graph = "main";
  }
  for (const [name, saved] of Object.entries(layouts)) {
    if (!Object.hasOwn(next.graphs, name)) {
      delete layouts[name];
      continue;
    }
    const ids = new Set([INPUT, OUTPUT, ...next.graphs[name].nodes.map((n) => n.id)]);
    for (const id of Object.keys(saved)) if (!ids.has(id)) delete saved[id];
  }
  if (placement) (layouts[graph] ??= {})[placement.id] = placement.point;
  rev++;
  if (!Object.hasOwn(definition.graphs, graph)) graph = "main";
  render(refit);
  persist();
}
const validateDraft = (next) => api("check", { definition: next, draft: true });
const contextMenu = createContextMenu();
let binding;
const bindingPicker = createPicker($("binding-slot"), (value) => {
  binding.slot = Number(value);
  previewBinding();
});
function previewBinding() {
  const { from, to, slots, slot } = binding;
  const body = structuredClone(definition.graphs[graph]);
  connectBinding(body, from, to, slots[slot].path);
  bindingPicker.set(
    slots.map(({ path }, i) => ({
      value: String(i),
      label: [to === OUTPUT ? "output" : "input", ...path].join("."),
    })),
    String(slot),
  );
  $("binding-preview").textContent = pretty(
    to === OUTPUT ? body.output : body.nodes.find((n) => n.id === to).input,
  );
}
function openBinding(from, to) {
  const body = definition.graphs[graph];
  const value = to === OUTPUT ? outputMapping(body) : body.nodes.find((n) => n.id === to).input;
  const slots = bindingSlots(value);
  const key = from === INPUT ? "input" : from;
  let slot = slots.findIndex((s) => s.vacant);
  if (
    to === OUTPUT &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Object.keys(value).some((k) => k.startsWith("$"))
  ) {
    slot = slots.findIndex((s) => s.path.length === 1 && s.path[0] === key);
    if (slot < 0) slot = slots.push({ path: [key] }) - 1;
  }
  binding = { from, to, slots, slot: Math.max(0, slot), graph, rev };
  $("binding-from").textContent = from + " → " + to;
  $("binding-error").textContent = "";
  previewBinding();
  $("binding-dialog").showModal();
}
$("binding-close").onclick = () => $("binding-dialog").close();
$("binding-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    if (binding.rev !== rev || binding.graph !== graph) throw new Error(t("resend"));
    const { from, to, slots, slot } = binding;
    await changeGraph((body) => connectBinding(body, from, to, slots[slot].path));
    $("binding-dialog").close();
  } catch (err) {
    $("binding-error").textContent = err.message;
  }
};
async function changeGraph(mutate, placement) {
  requireClean();
  const version = rev,
    selected = graph,
    next = structuredClone(definition);
  mutate(next.graphs[graph], next);
  pruneConditions(next.graphs[graph]);
  await validateDraft(next);
  requireClean();
  if (version !== rev || selected !== graph) throw new Error(t("resend"));
  commit(next, false, placement);
}
function attempt(action) {
  return async () => {
    try {
      await action();
    } catch (e) {
      notice(e.message);
    }
  };
}
function removeEdge(edge) {
  return attempt(() =>
    changeGraph((body) => {
      if (edge.range !== undefined) body.loops.splice(edge.range, 1);
      else disconnect(body, edge);
      pruneRanges(body);
    }),
  )();
}
function pruneRanges(body) {
  if (!body.loops) return;
  const ids = new Set(body.nodes.map((n) => n.id));
  body.loops = body.loops.filter(
    (r) => ids.has(r.entry) && ids.has(r.end) && rangeMembers(body, r.entry, r.end).has(r.end),
  );
  if (!body.loops.length) delete body.loops;
}
function contextActions(event) {
  if (!definition) return;
  const { id, edge, point } = event;
  const actions = [];
  const add = (key, fn) => actions.push([t(key), attempt(fn)]);
  let title = graph;
  if (edge?.range !== undefined) {
    title = t("loopRange");
    add("loopRange", () => localLoops.open(edge.to, edge.from, edge.range));
    add("removeLoop", () => removeEdge(edge));
  } else if (edge) {
    title = edge.from + " → " + edge.to;
    add("edgeCondition", () => edgeDialog.open(edge));
    add("disconnectEdge", () => removeEdge(edge));
    if (!edge.reference) add("loopRange", () => localLoops.open(edge.from, edge.to));
    if (edge.to === OUTPUT) add("editOutput", () => structure.graphDialog(true));
    else add("editDestination", () => openNode(edge.to));
    if (edge.from !== INPUT) add("editSourceNode", () => openNode(edge.from));
  } else if (id === INPUT || id === OUTPUT) {
    title = t(id === INPUT ? "input" : "output");
    add("editGraph", () => structure.graphDialog(true));
  } else if (id) {
    const node = definition.graphs[graph].nodes.find((n) => n.id === id);
    const sub = node.kind === "subgraph";
    title = id;
    if (sub) add("editSubgraph", () => navigate(node.graph));
    add(sub ? "editCall" : "editNode", () => openNode(id));
    add("repeatNodes", () => localLoops.open(id, id));
    add(sub ? "duplicateCall" : "duplicateNode", () => {
      const copy = structuredClone(node);
      copy.id = nextName(
        id + "_copy",
        definition.graphs[graph].nodes.map((n) => n.id),
      );
      copy.input = withoutGraphInput(copy.input);
      return changeGraph((body) => appendNode(body, copy), {
        id: copy.id,
        point: { x: point.x + 25, y: point.y + 25 },
      });
    });
    add(sub ? "removeCall" : "deleteNode", () =>
      changeGraph((body, next) => removeGraphNode(next, graph, id)),
    );
  } else {
    add("addNode", () => openLibrary(point));
    add("createSubgraph", () => structure.graphDialog(false, point));
    add("editLoop", () => structure.openLoop());
    add("newCanvas", () => library.promptCanvas(false));
    add("importJson", () => importer.open());
    add("canvasHistory", () => library.openHistory());
    add("clearCanvas", () => library.promptCanvas(true));
  }
  contextMenu.open(event, title, actions);
}
function removeGraphNode(next, graphId, id) {
  const body = next.graphs[graphId];
  for (const node of body.nodes)
    if (node.dependsOn?.includes(id)) disconnect(body, { from: id, to: node.id });
  if (body.output !== undefined) disconnect(body, { from: id, to: OUTPUT });
  body.nodes = body.nodes.filter((n) => n.id !== id);
  pruneRanges(body);
  // Deployment bindings use expanded call paths, including those of other graphs calling this one.
  function includesNode(path, owner) {
    for (const part of path.split("/")) {
      if (owner === graphId && part === id) return true;
      owner = next.graphs[owner]?.nodes.find((n) => n.id === part)?.graph;
      if (!owner) return false;
    }
    return false;
  }
  for (const [owner, bindings] of Object.entries(next.deployment?.bindings || {})) {
    for (const path of Object.keys(bindings)) if (includesNode(path, owner)) delete bindings[path];
  }
}
const canvas = createCanvas({
  editCondition: (edge) => edgeDialog.open(edge),
  menu: contextActions,
  removeEdge,
  editRange: (i) => localLoops.open(undefined, undefined, i),
  edit: (id) => openNode(id),
  openSubgraph: (id) => navigate(definition.graphs[graph].nodes.find((n) => n.id === id).graph),
  link: async (from, to) => {
    try {
      requireClean();
      if (from === INPUT || to === OUTPUT) return openBinding(from, to);
      if (rangeMembers(definition.graphs[graph], to, from).has(from)) return localLoops.open(to, from);
      const version = rev,
        selectedGraph = graph,
        next = structuredClone(definition),
        node = next.graphs[graph].nodes.find((n) => n.id === to);
      if (node.dependsOn?.includes(from)) return notice(t("alreadyLinked"));
      (node.dependsOn ??= []).push(from);
      await validateDraft(next);
      if (version !== rev || selectedGraph !== graph) throw new Error(t("retryLink"));
      requireClean();
      commit(next, false);
      notice(t("linked", { from, to }));
    } catch (e) {
      notice(e.message);
    }
  },
  remember: (id, position) => {
    if (!Object.hasOwn(layouts, graph)) layouts[graph] = {};
    layouts[graph][id] = position;
    persist();
  },
});
function render(refit = true) {
  contextMenu.close();
  const names = Object.keys(definition.graphs),
    nodes = definition.graphs[graph].nodes;
  graphsPicker.set(
    names.map((name) => ({ value: name, label: name })),
    graph,
  );
  $("filename").textContent = filename;
  $("canvases").disabled = false;
  $("open").disabled = false;
  graphLabels(nodes);
  raw.value = pretty(definition);
  $("source-error").textContent = "";
  $("undo").disabled = !undo.length;

  drawCanvas(refit);
}
function drawCanvas(refit) {
  const body = definition.graphs[graph];
  loopColors = assignLoopColors(definition.graphs, loopColors);
  const ranges = (body.loops || []).map((r, i) => ({
    color: rangeColor(loopColors, graph, r),
    label: rangeLabel(r, t),
    edit: () => localLoops.open(undefined, undefined, i),
  }));
  drawLoopMap(definition.loop, t, structure.openLoop, navigate, ranges);
  canvas.display(body, Object.hasOwn(layouts, graph) ? layouts[graph] : {}, refit, t, ranges);
}
function graphLabels(nodes) {
  const count = nodes.reduce((sum, node) => sum + (node.dependsOn?.length || 0), 0);
  $("stats").textContent =
    locale === "en"
      ? `${nodes.length} ${nodes.length === 1 ? "node" : "nodes"} · ${count} ${count === 1 ? "dependency" : "dependencies"}`
      : `${nodes.length} 节点 · ${count} 条依赖`;
  $("greeting").textContent = definition.id + " / " + graph;
  const editGraph = $("edit-graph");
  editGraph.dataset.aria = editGraph.dataset.title =
    graph === "main" ? "editGraph" : "editSubgraphDefinition";
  editGraph.title = t(editGraph.dataset.title);
  editGraph.setAttribute("aria-label", editGraph.title);
  $("open-loop").classList.toggle("configured", Boolean(definition.loop));
  $("open-loop").querySelector("span").textContent = definition.loop
    ? t("agentLoop") + " · " + Object.keys(definition.loop.steps).length
    : "+ " + t("agentLoop");
}
$("language").onclick = () => {
  locale = locale === "en" ? "zh-CN" : "en";
  t = translator(locale);
  try {
    localStorage.setItem(preference, locale);
  } catch {
    /* The current session still uses this choice. */
  }
  translatePage();
  discussions.draw();
  if (definition) {
    graphLabels(definition.graphs[graph].nodes);
    drawCanvas(false);
  }
};
function setTab(source) {
  $("conversation").hidden = source;
  $("source").hidden = !source;
  $("chat-tab").classList.toggle("active", !source);
  $("json-tab").classList.toggle("active", source);
}
$("chat-tab").onclick = () => {
  try {
    requireClean();
    setTab(false);
  } catch (e) {
    $("source-error").textContent = e.message;
  }
};
$("json-tab").onclick = () => setTab(true);
function navigate(name) {
  try {
    requireClean();
    graph = name;
    render();
    persist();
  } catch (e) {
    notice(e.message);
  }
}
const graphsPicker = createPicker($("graphs"), navigate);
$("undo").onclick = () => {
  try {
    requireClean();
    if (!undo.length) return;
    ({ definition, graph, layouts, loopColors } = undo.pop());
    rev++;
    if (!Object.hasOwn(definition.graphs, graph)) graph = "main";
    render();
    persist();
    notice(t("undone"));
  } catch (e) {
    notice(e.message);
  }
};
$("revert").onclick = () => {
  raw.value = pretty(definition);
  $("source-error").textContent = "";
};
$("apply").onclick = async () => {
  const original = raw.value,
    version = rev;
  try {
    const next = JSON.parse(original);
    await validateDraft(next);
    if (version !== rev || original !== raw.value) throw new Error(t("retrySource"));
    commit(next);
    raw.value = pretty(definition);
    $("source-error").textContent = "";
    notice(t("synced"));
  } catch (e) {
    $("source-error").textContent = e.message;
  }
};
function showWorker(worker) {
  selectedWorker = worker;
  const available = installed.has(worker.name);
  for (const button of $("worker-list").children)
    button.setAttribute("aria-pressed", String(button.value === worker.name));
  $("worker-title").textContent = worker.title[locale];
  $("package-status").hidden = !worker.packageName;
  $("package-status").textContent = worker.packageName
    ? (available ? "" : t("missingPackage") + " · ") + worker.packageName
    : "";
  $("option-list").replaceChildren(
    ...worker.nodes.map((option) => {
      const b = el("button", "node-choice");
      b.disabled = !available;
      b.append(el("strong", "", option.type), el("span", "", option.description[locale]));
      b.onclick = () => {
        $("library").close();
        openNode(null, option, additionPoint);
      };
      return b;
    }),
  );
}
function openLibrary(point) {
  additionPoint = point;
  try {
    requireClean();
  } catch (e) {
    return notice(e.message);
  }
  if (!definition) return;
  $("worker-list").replaceChildren(
    ...workers.map((worker) => {
      const b = el("button", "worker-choice");
      b.value = worker.name;
      const available = installed.has(worker.name);
      b.classList.toggle("unavailable", !available);
      b.append(
        el("strong", "", worker.name),
        el("span", "", worker.title[locale] + (available ? "" : " · " + t("missingPackage"))),
      );
      b.onclick = () => showWorker(worker);
      return b;
    }),
  );
  showWorker(selectedWorker);
  $("library").showModal();
}
function openNode(id, option, point) {
  additionPoint = point;
  try {
    requireClean();
  } catch (e) {
    return notice(e.message);
  }
  const nodes = definition.graphs[graph].nodes;
  const node = id ? nodes.find((n) => n.id === id) : makeNode(option, nodes);
  dialogNode = id;
  const info = catalog.get(node.type);
  $("dialog-title").textContent = id
    ? t(node.kind === "subgraph" ? "editCall" : "editNode") + " · " + id
    : node.type;
  $("node-description").hidden = !info;
  $("node-description").textContent = info?.description[locale] || "";
  const inputLabel = document.querySelector('label[for="node-json"] [data-text]');
  inputLabel.dataset.text = node.kind === "subgraph" ? "callJson" : "nodeJson";
  inputLabel.textContent = t(inputLabel.dataset.text);
  $("remove").hidden = !id;
  $("back-library").hidden = Boolean(id);
  $("confirm-node").textContent = t(id ? "apply" : "addCanvas");
  $("node-error").textContent = "";
  $("node-json").value = pretty(node);
  dialog.showModal();
}
$("first-node").onclick = $("add").onclick = () => openLibrary();
$("library-close").onclick = () => $("library").close();
$("back-library").onclick = () => {
  dialog.close();
  openLibrary(additionPoint);
};
$("dismiss").onclick = () => dialog.close();
async function applyNode(remove) {
  try {
    const version = rev,
      next = structuredClone(definition),
      nodes = next.graphs[graph].nodes,
      index = nodes.findIndex((n) => n.id === dialogNode);
    if (remove) removeGraphNode(next, graph, dialogNode);
    else if (index < 0) appendNode(next.graphs[graph], JSON.parse($("node-json").value));
    else nodes[index] = JSON.parse($("node-json").value);
    pruneConditions(next.graphs[graph]);
    await validateDraft(next);
    if (version !== rev) throw new Error(t("retryNode"));
    const place = !remove && index < 0 && additionPoint;
    commit(next, !place, place ? { id: nodes.at(-1).id, point: place } : undefined);
    dialog.close();
  } catch (e) {
    $("node-error").textContent = e.message;
  }
}
$("node-form").onsubmit = (e) => {
  e.preventDefault();
  applyNode(false);
};
$("remove").onclick = () => applyNode(true);
function recommendedNode(type) {
  const option = catalog.get(type);
  if (!option) return null;
  const button = el("button", "recommended");
  button.disabled = !installed.has(type.split(".")[0]);
  button.append(icon("plus"), el("span", "", type));
  button.title = option.description[locale];
  button.onclick = () => openNode(null, option);
  return button;
}
const discussions = createDiscussions({
  t: (key) => t(key),
  notice,
  getGraph: () => graph,
  recommend: recommendedNode,
  async request({ prompt, history, attachment }, isCurrent) {
    requireClean();
    const version = rev,
      sendingGraph = graph;
    if (!attachment) {
      const command = prompt.trim().replace(/[。.!]$/, "");
      const create =
        /^(?:(?:create (?:a )?)?new canvas|create (?:a )?canvas|(?:新建|创建)(?:一个)?(?:新)?画布)(?:\s+(?:named\s+)?([\w-]+))?$/i.exec(
          command,
        );
      const clear = /^(?:clear (?:the |current )?canvas|清空(?:当前)?画布)$/i.test(command);
      const showHistory =
        /^(?:(?:open |show )?canvas history|(?:打开|进入|查看)?(?:画布历史|历史画布))$/i.test(command);
      if (create || clear || showHistory) {
        // Save the initiating turn to its canvas before opening a document action.
        setTimeout(() => {
          if (version !== rev || !isCurrent()) return;
          if (showHistory) library.openHistory();
          else library.promptCanvas(clear, create?.[1]);
        }, 0);
        return { message: t(create ? "newAction" : clear ? "clearAction" : "historyAction") };
      }
    }
    const result = await api("chat", { definition, graph, prompt, history, attachment });
    if (result.definition) {
      if (
        !isCurrent() ||
        version !== rev ||
        graph !== sendingGraph ||
        dirty() ||
        document.querySelector("dialog[open]")
      )
        throw new Error(t("resend"));
      commit(result.definition);
    }
    return result;
  },
});
$("compose").onsubmit = (e) => {
  e.preventDefault();
  discussions.send($("prompt").value.trim());
};
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $("compose").requestSubmit();
  }
};
for (const cmd of ["explain", "suggestMemory"]) {
  const b = el("button");
  const label = el("span");
  label.dataset.text = cmd;
  b.append(label);
  b.onclick = () => discussions.send(t(cmd));
  $("suggestions").append(b);
}
const handles = new Map(),
  undoByCanvas = new Map();
function guardSwitch() {
  requireClean();
  if (discussions.hasPending()) throw new Error(t("waitChat"));
}
function activate(record) {
  if (canvasId) undoByCanvas.set(canvasId, undo);
  canvasId = record.id;
  filename = record.filename;
  definition = record.definition;
  layouts = record.layouts || {};
  loopColors = record.loopColors || {};
  graph = Object.hasOwn(definition.graphs, record.graph) ? record.graph : "main";
  undo = undoByCanvas.get(canvasId) || [];
  documentKey = record.documentKey || canvasId;
  fileHandle = handles.get(canvasId);
  discussions.load(documentKey);
  rev++;
  render();
  try {
    history.select(canvasId);
  } catch {
    notice(t("storageFailed"));
  }
}
function selectAfterRemoval(remaining) {
  if (remaining) return activate(remaining);
  const id = crypto.randomUUID();
  activate({ id, filename: "untitled.json", definition: blankDefinition("untitled"), documentKey: id });
  persist();
}
const library = initCanvasLibrary({
  t: (key, args) => t(key, args),
  state: () => ({ id: canvasId, filename, rev }),
  list: () => history.list(),
  guard: guardSwitch,
  notice,
  async remove(id) {
    const record = history.read(id);
    if (!record) return;
    const remaining = history.list().filter((r) => r.id !== id);
    if (id === canvasId) {
      guardSwitch();
      const version = rev;
      if (remaining.length) await validateDraft(remaining[0].definition);
      guardSwitch();
      if (version !== rev || id !== canvasId) throw new Error(t("resend"));
    }
    history.remove(id);
    if (id === canvasId) selectAfterRemoval(remaining[0]);
    handles.delete(id);
    undoByCanvas.delete(id);
    if (!remaining.some((r) => r.documentKey === record.documentKey))
      discussions.forget(record.documentKey || id);
  },
  async select(id) {
    guardSwitch();
    const version = rev,
      record = history.read(id);
    await validateDraft(record.definition);
    guardSwitch();
    if (version !== rev) throw new Error(t("resend"));
    activate(record);
  },
  async create(name) {
    const version = rev,
      next = blankDefinition(name);
    await validateDraft(next);
    guardSwitch();
    if (version !== rev) throw new Error(t("resend"));
    const id = crypto.randomUUID();
    activate({ id, definition: next, filename: name + ".json", documentKey: id });
    persist();
  },
  clear() {
    commit(blankDefinition(definition.id, definition), true, undefined, true);
  },
});
const importer = initImportDialog({
  t: (key, args) => t(key, args),
  revision: () => rev,
  validate: validateDraft,
  notice,
  guard() {
    if (!canvasId) throw new Error(t("reading"));
    guardSwitch();
  },
  activate(next, name) {
    const id = crypto.randomUUID();
    activate({ id, filename: name, definition: next, documentKey: id });
    return persist();
  },
});
$("save").onclick = async () => {
  try {
    requireClean();
    const empty = Object.keys(definition.graphs).filter((key) => !definition.graphs[key].nodes.length);
    if (empty.length) throw new Error(t("draftExport", { graphs: empty.join(", ") }));
    const saving = canvasId;
    const content = pretty(definition) + "\n";
    if (window.showSaveFilePicker) {
      const handle =
        fileHandle ||
        (await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "Agent JSON", accept: { "application/json": [".json"] } }],
        }));
      const writer = await handle.createWritable();
      await writer.write(content);
      await writer.close();
      handles.set(saving, handle);
      if (saving !== canvasId) return;
      fileHandle = handle;
      filename = handle.name;
      $("filename").textContent = filename;
      persist();
      notice(t("saved"));
    } else {
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" })),
        a = el("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice(t("exported"));
    }
  } catch (e) {
    if (e.name !== "AbortError") notice(e.message);
  }
};
async function start() {
  const data = await api("start");
  definition = data.definition;
  filename = data.filename;
  documentKey = JSON.stringify([filename, definition.id]);
  const draftKey = "ditto-editor:v1:" + filename + ":" + definition.id;
  let storage;
  try {
    storage = window.localStorage;
  } catch {
    storage = {
      getItem: () => null,
      removeItem() {},
      setItem() {
        throw new Error(t("storageFailed"));
      },
    };
  }
  history = createCanvasHistory(storage, draftKey);
  window.addEventListener("storage", (event) => {
    if (event.key === history.recordKey(canvasId) && event.newValue === null) {
      const removedId = canvasId;
      selectAfterRemoval(history.list()[0]);
      undoByCanvas.delete(removedId);
      handles.delete(removedId);
    }
  });
  installed = new Set(data.installedWorkers);
  let initial = { definition, filename, documentKey, id: crypto.randomUUID() };
  try {
    const active = history.active();
    const saved = active ? history.read(active) : JSON.parse(storage.getItem(draftKey));
    if (saved) {
      await validateDraft(saved.definition);
      initial = {
        ...initial,
        ...saved,
        documentKey: saved.documentKey || JSON.stringify([saved.filename, saved.definition.id]),
      };
    }
  } catch {
    notice(t("draftFailed"));
  }
  activate(initial);
  if (!initial.updated) persist();
}
const structure = initStructure({
  t: (key) => t(key),
  current: () => ({ definition, graph, rev }),
  validate: validateDraft,
  apply: commit,
  requireClean,
  notice,
  navigate,
});
const localLoops = initLocalLoops({
  current: () => ({ definition, graph, rev }),
  t: (key) => t(key),
  change: changeGraph,
  requireClean,
  notice,
});
const edgeDialog = initEdgeDialog({
  t: (key) => t(key),
  requireClean,
  notice,
  change: changeGraph,
  current: () => ({ graph, rev }),
});
initModelDialog({ api, t: (key) => t(key), notice });
initSidebar();
translatePage();
start().catch((e) => {
  $("greeting").textContent = t("openFailed", { error: e.message });
});
