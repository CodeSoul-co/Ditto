import { el, icon } from "./canvas.js";
import { createPicker } from "./picker.js";

const $ = (id) => document.getElementById(id);
const comparisons = { eq: "=", ne: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥" };
export function expressionLabel(value) {
  if (value?.$ref && !Object.hasOwn(value, "default")) return value.$ref;
  if (value?.$op && Array.isArray(value.args)) {
    const args = value.args.map(expressionLabel);
    return comparisons[value.$op]
      ? args.join(" " + comparisons[value.$op] + " ")
      : value.$op + "(" + args.join(", ") + ")";
  }
  return JSON.stringify(value);
}
export function drawLoopMap(loop, t, edit, navigate, ranges) {
  const panel = $("loop-map"),
    track = $("loop-track"),
    toggle = $("loop-expand");
  panel.hidden = !loop && !ranges.length;
  if (panel.hidden) return;
  panel.classList.toggle("local-only", !loop);
  $("loop-limit").textContent = loop ? t("limit", { count: loop.maxIterations }) : "";
  const legend = $("range-legend");
  legend.replaceChildren(
    ...ranges.map(({ color, label, edit }) => {
      const button = el("button", "legend-range", label);
      button.style.setProperty("--loop-color", color);
      button.title = label;
      button.onclick = edit;
      return button;
    }),
  );
  const guard = $("loop-while");
  guard.textContent = loop?.while === undefined ? "" : t("while") + " · " + expressionLabel(loop.while);
  function visibility() {
    const open = toggle.getAttribute("aria-expanded") === "true";
    guard.hidden = !open || loop?.while === undefined;
    track.hidden = !open || !loop;
    legend.hidden = !open || !ranges.length;
  }
  toggle.onclick = () => {
    toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
    visibility();
  };
  visibility();
  track.replaceChildren(
    ...Object.entries(loop?.steps || {}).map(([id, step]) => {
      const card = el("article", "loop-step");
      const title = el("button", "step-title");
      title.append(el("strong", "", id), icon("edit"));
      if (loop.entry === id) title.append(el("small", "", t("loopEntry")));
      title.title = t("editLoop") + " · " + id;
      title.onclick = () => edit(id);
      const graph = el("button", "step-graph-link", t("run") + " · " + step.graph);
      graph.onclick = () => navigate(step.graph);
      const insert = el("button", "step-insert");
      insert.append(icon("plus"));
      insert.title = t("addStep") + " · " + id;
      insert.setAttribute("aria-label", insert.title);
      insert.onclick = () => edit(id, undefined, true);
      card.append(title, graph, insert);
      for (const [index, transition] of step.transitions.entries()) {
        const row = el("button", "loop-route " + (transition.next ? "next" : "end"));
        const label = Object.hasOwn(transition, "when")
          ? expressionLabel(transition.when)
          : t(step.transitions.length === 1 ? "always" : "otherwise");
        const target = transition.next ?? t("finish") + " · " + transition.end;
        row.append(el("span", "", label), el("b", "", (transition.next === id ? "↺ " : "→ ") + target));
        row.title = label + " → " + target;
        row.onclick = () => edit(id, index);
        card.append(row);
      }
      return card;
    }),
  );
}

function operand(value) {
  const s = value.trim();
  if (/^(state|config|result|input)(\.[\w-]+)*$/.test(s)) return { $ref: s };
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
function simple(value) {
  return (
    value === null ||
    typeof value !== "object" ||
    (typeof value.$ref === "string" && Object.keys(value).length === 1)
  );
}
export function drawRuleFields(rules, steps, t, sync, redraw, signal) {
  const root = $("condition-rows");
  function picker(label, options, value, choose) {
    const host = el("div");
    host.id = "rule-" + crypto.randomUUID();
    host.dataset.label = label;
    host.setAttribute("aria-label", t(label));
    const control = createPicker(
      host,
      (v) => {
        choose(v);
        control.set(options, v);
        sync();
      },
      signal,
    );
    control.set(options, value);
    return host;
  }
  root.replaceChildren(
    ...rules.map((rule, i) => {
      const row = el("div", "condition-row");
      const expr = rule.when;
      if (Object.hasOwn(comparisons, expr?.$op) && expr.args?.length === 2 && expr.args.every(simple)) {
        const input = (pos, key) => {
          const field = el("input");
          field.setAttribute("aria-label", t(key));
          field.value = expressionLabel(expr.args[pos]);
          field.oninput = () => {
            expr.args[pos] = operand(field.value);
            sync();
          };
          return field;
        };
        const ops = Object.entries(comparisons).map(([value, label]) => ({ value, label }));
        row.append(
          input(0, "leftOperand"),
          picker("operator", ops, expr.$op, (v) => {
            expr.$op = v;
          }),
          input(1, "rightOperand"),
        );
      } else {
        const custom = el("button", "custom-condition", expressionLabel(expr));
        custom.type = "button";
        custom.title = t("advancedRule");
        custom.onclick = () => {
          $("advanced-conditions").open = true;
          $("step-conditions").focus();
        };
        row.append(custom);
      }
      const end = rule.end || "completed";
      const options = [
        { value: "@end", label: t("finish") + " · " + end },
        ...steps.map((value) => ({ value, label: "→ " + value })),
      ];
      const dest = picker("destination", options, rule.next || "@end", (v) => {
        delete rule.next;
        delete rule.end;
        if (v === "@end") rule.end = end;
        else rule.next = v;
        reason.hidden = v !== "@end";
      });
      const remove = el("button", "remove-condition");
      remove.type = "button";
      remove.setAttribute("aria-label", t("removeRule"));
      remove.append(icon("x"));
      remove.onclick = () => {
        rules.splice(i, 1);
        sync();
        redraw();
      };
      const reason = el("label", "condition-end-field", t("endLabel"));
      const field = el("input", "condition-end");
      field.value = end;
      field.spellcheck = false;
      field.oninput = () => {
        rule.end = field.value.trim();
        sync();
      };
      reason.hidden = !rule.end;
      reason.append(field);
      row.append(dest, remove, reason);
      return row;
    }),
  );
}
