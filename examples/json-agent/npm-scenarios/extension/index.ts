import type { NodeContract } from "@codesoul-co/ditto/contracts";
import { defineNode, defineWorker } from "@codesoul-co/ditto/worker";

export interface TextRequest { text: string; mode: "research" | "recall" }
declare module "@codesoul-co/ditto/contracts" {
  interface NodeContractMap {
    "EXAMPLE.NPM.TEXT.NORMALIZE": NodeContract<TextRequest, TextRequest>;
    "EXAMPLE.NPM.TEXT.ROUTE": NodeContract<TextRequest, TextRequest>;
    "EXAMPLE.NPM.TEXT.FORMAT": NodeContract<TextRequest, { text: string }>;
  }
}
function validate(input: TextRequest): void {
  if (!input || typeof input.text !== "string" || input.text.length > 10_000 || !["research", "recall"].includes(input.mode))
    throw new Error("Expected bounded text and research/recall mode");
}
export const normalizeNode = defineNode("example-text", "EXAMPLE.NPM.TEXT.NORMALIZE", async input => {
  validate(input);
  return { ...input, text: input.text.trim().normalize("NFC") };
});
export const routeNode = defineNode("example-text", "EXAMPLE.NPM.TEXT.ROUTE", async input => {
  validate(input);
  return input;
});
export const formatNode = defineNode("example-text", "EXAMPLE.NPM.TEXT.FORMAT", async input => {
  validate(input);
  return { text: `Text: ${input.text}` };
});
export function createTextWorker() {
  return defineWorker({ type: "example-text", nodes: {
    "EXAMPLE.NPM.TEXT.NORMALIZE": normalizeNode,
    "EXAMPLE.NPM.TEXT.ROUTE": routeNode,
    "EXAMPLE.NPM.TEXT.FORMAT": formatNode,
  } });
}
