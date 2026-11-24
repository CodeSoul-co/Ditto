import { createPicker } from "./picker.js";
import { drawRuleFields } from "./loop-map.js";
import { nextName, newSubgraph, insertCall, newLoop, appendStep } from "./structure.js";
const $ = (id) => document.getElementById(id),
  pretty = (x) => JSON.stringify(x, null, 2);
const entries = (names) => names.map((name) => ({ value: name, label: name }));
export function initStructure({ t, current, validate, apply, requireClean, notice, navigate }) {
  const sg = $("subgraph-dialog"),
    ld = $("loop-dialog");
  let source,
    revision,
    parent,
    kind,
    target,
    loop,
    step,
    raw = false,
    ruleListeners;
  function begin() {
    requireClean();
    const state = current();
    source = state.definition;
    parent = state.graph;
    revision = state.rev;
    if (!source) throw new Error(t("reading"));
  }
  function guard() {
    requireClean();
    if (current().rev !== revision || current().graph !== parent) throw new Error(t("resend"));
  }
  const existing = createPicker($("existing-graph"), (value) => {
    target = value;
    existing.set(entries(candidates()), target);
  });
  function candidates() {
    return Object.keys(source.graphs).filter((name) => name !== parent && name !== "main");
  }
  function mode(value) {
    kind = value;
    $("sg-new").setAttribute("aria-pressed", String(kind === "new"));
    $("sg-use").setAttribute("aria-pressed", String(kind === "use"));
    $("sg-name-row").hidden = kind === "use";
    $("sg-name").readOnly = kind === "edit";
    $("sg-json-row").hidden = kind === "use";
    $("sg-insert-row").hidden = kind !== "new";
    $("sg-bind-row").hidden = kind === "edit" || (kind === "new" && !$("sg-insert").checked);
    $("existing-row").hidden = kind !== "use";
    $("sg-caption").textContent = t(
      kind === "edit"
        ? parent === "main"
          ? "editGraph"
          : "editSubgraphDefinition"
        : kind === "use"
          ? "insertSubgraph"
          : "createSubgraph",
    );
    $("sg-error").textContent = "";
    if (kind === "use") {
      target = candidates()[0];
      existing.set(entries(candidates()), target);
    }
  }
  let placement;
  function graphDialog(edit = false, point) {
    try {
      begin();
    } catch (e) {
      return notice(e.message);
    }
    $("sg-modes").hidden = edit;
    $("sg-use").disabled = !candidates().length;
    $("sg-name").value = edit ? parent : nextName("subgraph", Object.keys(source.graphs));
    $("sg-json").value = pretty(edit ? source.graphs[parent] : newSubgraph());
    $("sg-insert").checked = true;
    $("sg-bind").checked = false;
    placement = point;
    $("sg-parent").textContent = parent;
    mode(edit ? "edit" : "new");
    sg.showModal();
  }
  $("edit-graph").onclick = () => graphDialog(true);
  $("add-subgraph").onclick = () => graphDialog();
  $("sg-close").onclick = () => sg.close();
  $("sg-new").onclick = () => mode("new");
  $("sg-use").onclick = () => mode("use");
  $("sg-insert").onchange = () => {
    $("sg-bind-row").hidden = !$("sg-insert").checked;
  };
  $("sg-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      guard();
      const next = structuredClone(source);
      const name = kind === "use" ? target : $("sg-name").value.trim();
      if (kind === "new" && Object.hasOwn(next.graphs, name)) throw new Error(t("duplicateGraph"));
      if (kind !== "use")
        Object.defineProperty(next.graphs, name, {
          value: JSON.parse($("sg-json").value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      const linked = kind === "use" || (kind === "new" && $("sg-insert").checked);
      if (linked) insertCall(next, parent, name, $("sg-bind").checked);
      await validate(next);
      guard();
      apply(
        next,
        true,
        linked && placement ? { id: next.graphs[parent].nodes.at(-1).id, point: placement } : undefined,
      );
      sg.close();
      if (kind === "new") navigate(name);
    } catch (err) {
      $("sg-error").textContent = err.message;
    }
  };
  const stepPicker = createPicker($("step-picker"), (v) =>
    prepared(() => {
      step = v;
      draw();
    }),
  );
  const entryPicker = createPicker($("entry-picker"), (v) =>
    prepared(() => {
      loop.entry = v;
      draw();
    }),
  );
  const graphPicker = createPicker($("step-graph"), (v) =>
    prepared(() => {
      loop.steps[step].graph = v;
      draw();
    }),
  );
  function destOptions(transition) {
    const end = transition.end || "completed";
    return [{ value: "@end", label: t("finishLoop") + " · " + end }, ...entries(Object.keys(loop.steps))];
  }
  const nextPicker = createPicker($("next-step"), (v) =>
    prepared(() => {
      const transitions = loop.steps[step].transitions,
        previous = transitions.at(-1);
      transitions[transitions.length - 1] = v === "@end" ? { end: previous.end || "completed" } : { next: v };
      draw();
    }),
  );
  function draw() {
    const keys = Object.keys(loop.steps);
    if (!Object.hasOwn(loop.steps, step)) step = loop.entry;
    const def = loop.steps[step],
      last = def.transitions.at(-1);
    $("loop-budget").value = loop.maxIterations;
    entryPicker.set(entries(keys), loop.entry);
    stepPicker.set(entries(keys), step);
    graphPicker.set(entries(Object.keys(source.graphs)), def.graph);
    $("default-end-row").hidden = !last.end;
    $("default-end").value = last.end || "";
    nextPicker.set(destOptions(last), last.next || "@end");
    const rules = def.transitions.slice(0, -1);
    ruleListeners?.abort();
    ruleListeners = new AbortController();
    const sync = () => {
      $("step-conditions").value = pretty(rules);
      loop.steps[step].transitions = [...rules, last];
    };
    sync();
    drawRuleFields(rules, keys, t, sync, draw, ruleListeners.signal);
    $("loop-delete").hidden = !source.loop;
    $("loop-error").textContent = "";
  }
  function readFields() {
    const rules = JSON.parse($("step-conditions").value);
    if (!Array.isArray(rules) || rules.some((r) => !r || !Object.hasOwn(r, "when")))
      throw new Error(t("conditionalRules"));
    loop.maxIterations = $("loop-budget").valueAsNumber;
    const last = loop.steps[step].transitions.at(-1);
    if (last.end !== undefined) last.end = $("default-end").value.trim();
    loop.steps[step].transitions = [...rules, loop.steps[step].transitions.at(-1)];
  }
  function prepared(action) {
    try {
      readFields();
      action();
    } catch (err) {
      $("loop-error").textContent = err.message;
    }
  }
  // Commit text changes before a step selection can replace the form.
  $("step-conditions").oninput = () => {
    try {
      readFields();
      $("loop-error").textContent = "";
    } catch (err) {
      $("loop-error").textContent = err.message;
    }
  };
  $("step-conditions").onchange = () => prepared(draw);
  $("add-condition").onclick = () =>
    prepared(() => {
      const transitions = loop.steps[step].transitions;
      transitions.splice(-1, 0, { when: { $op: "eq", args: [{ $ref: "result" }, true] }, end: "completed" });
      draw();
    });
  $("loop-budget").oninput = () => {
    loop.maxIterations = $("loop-budget").valueAsNumber;
  };
  function candidate() {
    const next = structuredClone(source);
    delete next.entry;
    next.loop = raw ? JSON.parse($("loop-json").value) : loop;
    return next;
  }
  function view(json) {
    raw = json;
    $("loop-fields").hidden = json;
    $("loop-json-row").hidden = !json;
    $("loop-visual").setAttribute("aria-pressed", String(!json));
    $("loop-source").setAttribute("aria-pressed", String(json));
  }
  $("loop-source").onclick = () => {
    if (!raw)
      prepared(() => {
        $("loop-json").value = pretty(loop);
        view(true);
      });
  };
  $("loop-visual").onclick = async () => {
    if (!raw) return;
    try {
      const next = candidate();
      await validate(next);
      loop = next.loop;
      view(false);
      draw();
    } catch (err) {
      $("loop-error").textContent = err.message;
    }
  };
  $("add-step").onclick = () =>
    prepared(() => {
      step = appendStep(loop, step, parent);
      draw();
    });
  function openLoop(selected, rule, append = false) {
    try {
      begin();
    } catch (e) {
      return notice(e.message);
    }
    loop = structuredClone(source.loop || newLoop());
    step = Object.hasOwn(loop.steps, selected) ? selected : loop.entry;
    if (append) step = appendStep(loop, step, parent);
    $("advanced-conditions").open = false;
    view(false);
    draw();
    ld.showModal();
    if (rule !== undefined) {
      const field =
        $("condition-rows").children[rule]?.querySelector("input,button") ||
        $("next-step").querySelector("button");
      field.focus();
    }
  }
  $("open-loop").onclick = () => openLoop();
  $("loop-close").onclick = () => ld.close();
  async function save(remove) {
    try {
      guard();
      if (!remove && !raw) readFields();
      const next = remove ? structuredClone(source) : candidate();
      if (remove) delete next.loop;
      await validate(next);
      guard();
      apply(next);
      ld.close();
    } catch (err) {
      $("loop-error").textContent = err.message;
    }
  }
  $("loop-form").onsubmit = (e) => {
    e.preventDefault();
    save(false);
  };
  $("loop-delete").onclick = () => save(true);
  return { graphDialog, openLoop };
}
