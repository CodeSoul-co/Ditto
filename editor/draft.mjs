import { randomUUID } from "node:crypto";
import { validateAgent } from "@codesoul-co/ditto/runtime";

export function checkDefinition(definition, allowEmpty = false) {
  let candidate = definition;
  const graphs = definition?.graphs;
  if (allowEmpty && graphs && typeof graphs === "object") {
    const empty = Object.keys(graphs).filter(
      (id) => Array.isArray(graphs[id]?.nodes) && !graphs[id].nodes.length,
    );
    if (empty.length) {
      // Validate all other fields and references through the compiler. The temporary
      // node exists only in the validation copy and cannot be named by a draft binding.
      candidate = structuredClone(definition);
      for (const id of empty) {
        candidate.graphs[id].nodes.push({ id: "draft_" + randomUUID(), type: "CONTEXT.LOAD", input: {} });
      }
    }
  }
  const [error] = validateAgent(candidate);
  if (error) throw new Error(`${error.path || "/"} · ${error.message}`);
}
