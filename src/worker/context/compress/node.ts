import { createNodeScaffold } from "../../node-scaffold.js";
import type { ContextExecution } from "../types.js";
import { checkedItem, estimateTokens, snapshotContext } from "../execution.js";
import { check, ContextError, context } from "../validation.js";
import { deterministicCompress } from "./strategies/deterministic.js";
import { validateProtection } from "../protection.js";
import { validateCompress } from "./schema.js";
import type { ContextCompressInput, ContextCompressOutput } from "./types.js";

async function validateCompressed(
  input: ContextCompressInput,
  output: unknown,
  execution: ContextExecution,
): Promise<ContextCompressOutput> {
  try { context(output, "compressed context"); }
  catch { throw new ContextError("INVALID_PROVIDER_OUTPUT", "Compressor returned an invalid Context"); }
  const inputIds = new Set(input.context.items.map(item => item.id));
  check(output.items.every(item => inputIds.has(item.id)), "Compressor introduced a new Context item", "INVALID_PROVIDER_OUTPUT");
  validateProtection(input.context.items, output.items);
  const maxItems = Math.min(input.maxItems ?? execution.policy.maxItems, execution.policy.maxItems);
  check(output.items.length <= maxItems, "Compressor exceeded maxItems", "INVALID_PROVIDER_OUTPUT");
  const maxTokens = execution.policy.maxTokens === undefined
    ? input.maxTokens
    : Math.min(input.maxTokens ?? execution.policy.maxTokens, execution.policy.maxTokens);
  if (maxTokens !== undefined) {
    const tokens = (await Promise.all(output.items.map(item => estimateTokens(item.content, execution))))
      .reduce((sum, value) => sum + value, 0);
    check(tokens <= maxTokens, "Compressor exceeded maxTokens", "INVALID_PROVIDER_OUTPUT");
  }
  return snapshotContext(output.items.map(item => checkedItem(item, execution)));
}

export async function compressNode(input: ContextCompressInput, execution: ContextExecution): Promise<ContextCompressOutput> {
  validateCompress(input);
  input = { ...input, context: snapshotContext(input.context.items) };
  const output = execution.services.compressor
    ? await execution.services.compressor.compress(input, execution)
    : await deterministicCompress(input, execution);
  return validateCompressed(input, output, execution);
}

export const contextCompressNode = createNodeScaffold("CONTEXT.COMPRESS");
