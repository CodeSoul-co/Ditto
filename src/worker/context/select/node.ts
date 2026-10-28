import { createNodeScaffold } from "../../node-scaffold.js";
import type { ContextItem } from "../../../contracts/common.js";
import type { ContextExecution } from "../types.js";
import { checkedItem, estimateTokens, snapshotContext } from "../execution.js";
import { check, ContextError, contextItem } from "../validation.js";
import { contextGroups, isProtectedContextItem, validateProtection } from "../protection.js";
import { defaultSelect } from "./strategies/default.js";
import { validateSelect } from "./schema.js";
import type { ContextSelectInput, ContextSelectOutput } from "./types.js";

async function candidates(input: ContextSelectInput, execution: ContextExecution): Promise<readonly ContextItem[]> {
  const kind = input.strategy?.kind ?? "default";
  if (kind === "default") return defaultSelect(input);
  const selector = kind === "rag" ? execution.services.ragStrategy : execution.services.selector;
  if (!selector) throw new ContextError("STRATEGY_UNAVAILABLE", `${kind} Context selection is not configured`);
  return selector.select(input, execution);
}

export async function selectNode(input: ContextSelectInput, execution: ContextExecution): Promise<ContextSelectOutput> {
  validateSelect(input);
  input = { ...input, context: snapshotContext(input.context.items) };
  const raw = await candidates(input, execution);
  check(Array.isArray(raw), "Selector must return an array", "INVALID_PROVIDER_OUTPUT");
  const seen = new Set<string>();
  const ranked: ContextItem[] = [];
  const limit = Math.min(input.limit ?? execution.policy.maxItems, execution.policy.maxItems);
  const tokenLimit = execution.policy.maxTokens === undefined
    ? input.maxTokens
    : Math.min(input.maxTokens ?? execution.policy.maxTokens, execution.policy.maxTokens);
  for (const [index, value] of raw.entries()) {
    try { contextItem(value, `selection[${index}]`); }
    catch { throw new ContextError("INVALID_PROVIDER_OUTPUT", "Selector returned an invalid Context item"); }
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    ranked.push(checkedItem(value, execution));
  }
  const protect = input.purpose === "infer";
  const required = protect
    ? contextGroups(input.context.items).filter(group => group.some(isProtectedContextItem)).flat()
      .map(item => checkedItem(item, execution))
    : [];
  // Selectors rank optional evidence; mandatory input is retained even when not retrieved.
  const rankedIds = new Set(ranked.map(item => item.id));
  const combined = [...required.filter(item => !rankedIds.has(item.id)), ...ranked];
  validateProtection(input.context.items, combined, protect);
  const requiredIds = new Set(required.map(item => item.id));
  const groups = contextGroups([...required, ...ranked.filter(item => !requiredIds.has(item.id))]).toSorted((a, b) =>
    Number(protect && b.some(isProtectedContextItem)) - Number(protect && a.some(isProtectedContextItem)));
  const selected: ContextItem[] = [];
  let tokens = 0;
  for (const group of groups) {
    const groupTokens = tokenLimit === undefined ? 0
      : (await Promise.all(group.map(item => estimateTokens(item.content, execution)))).reduce((sum, n) => sum + n, 0);
    if (selected.length + group.length > limit || (tokenLimit !== undefined && tokens + groupTokens > tokenLimit)) {
      if (protect && group.some(isProtectedContextItem)) {
        throw new ContextError("BUDGET_UNSATISFIABLE", "Protected Context items exceed the requested budget");
      }
      continue;
    }
    selected.push(...group);
    tokens += groupTokens;
  }
  const context = snapshotContext(selected);
  return Object.freeze({
    purpose: input.purpose,
    context,
    selectedItemIds: Object.freeze(context.items.map(item => item.id)),
  });
}

export const contextSelectNode = createNodeScaffold("CONTEXT.SELECT");
