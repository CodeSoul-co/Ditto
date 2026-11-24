import { OUTPUT, setCondition } from "./connections.js";
import { createPicker } from "./picker.js";

const $ = (id) => document.getElementById(id);
const operators = { eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" };
const modes = ["unconditional", "compareValues", "customExpression"];

export function initEdgeDialog({ t, change, requireClean, current, notice }) {
  const dialog = $("edge-dialog");
  let edge, opened, mode, operator;
  function comparison() {
    const text = $("edge-value").value.trim();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    return { $op: operator, args: [{ $ref: $("edge-field").value.trim() }, value] };
  }
  function display() {
    modePicker.set(
      modes.map((key) => ({ value: key, label: t(key) })),
      mode,
    );
    opPicker.set(
      Object.entries(operators).map(([value, label]) => ({ value, label })),
      operator,
    );
    $("edge-compare").hidden = mode !== "compareValues";
    $("edge-custom").hidden = mode !== "customExpression";
    $("edge-error").textContent = "";
  }
  const modePicker = createPicker($("edge-mode"), (value) => {
    if (value === "customExpression" && mode === "compareValues")
      $("edge-expr").value = JSON.stringify(comparison(), null, 2);
    mode = value;
    display();
  });
  const opPicker = createPicker($("edge-op"), (value) => {
    operator = value;
    display();
  });
  function open(target) {
    try {
      requireClean();
    } catch (e) {
      return notice(e.message);
    }
    edge = target;
    opened = current();
    const when = edge.when,
      left = when?.args?.[0];
    const simple =
      Object.hasOwn(operators, when?.$op) && typeof left?.$ref === "string" && Object.keys(left).length === 1;
    operator = simple ? when.$op : "eq";
    mode = when === undefined ? "unconditional" : simple ? "compareValues" : "customExpression";
    $("edge-ends").textContent = edge.from + " → " + edge.to;
    $("edge-help").textContent = t(edge.to === OUTPUT ? "outputGuardHelp" : "edgeGuardHelp");
    $("edge-field").value = simple ? left.$ref : "result";
    $("edge-value").value = simple ? JSON.stringify(when.args[1]) : "true";
    $("edge-expr").value = JSON.stringify(when ?? comparison(), null, 2);
    display();
    dialog.showModal();
  }
  $("edge-close").onclick = () => dialog.close();
  $("edge-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const state = current();
      if (opened.rev !== state.rev || opened.graph !== state.graph) throw new Error(t("resend"));
      const when =
        mode === "unconditional"
          ? undefined
          : mode === "compareValues"
            ? comparison()
            : JSON.parse($("edge-expr").value);
      await change((body) => setCondition(body, edge, when));
      dialog.close();
    } catch (e) {
      $("edge-error").textContent = e.message;
    }
  };
  return { open };
}
