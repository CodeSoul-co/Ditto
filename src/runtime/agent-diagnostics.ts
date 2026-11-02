export interface AgentDiagnostic {
  readonly code: string;
  /** RFC 6901 JSON Pointer into the configuration; empty string means the root. */
  readonly path: string;
  readonly message: string;
  readonly graphId?: string;
  readonly nodeId?: string;
}

export class AgentValidationError extends Error {
  readonly diagnostic: AgentDiagnostic;
  constructor(path: string, message: string, code = "INVALID_VALUE") {
    super(`Agent ${path || "definition"}: ${message}`);
    this.name = "AgentValidationError";
    const parts = path.split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    this.diagnostic = { code, path, message, ...(parts[1] === "graphs" && parts[2] ? { graphId: parts[2] } : {}) };
    if (parts[1] === "deployment" && parts[2] === "bindings" && parts[3])
      Object.assign(this.diagnostic, { graphId: parts[3], ...(parts[4] ? { nodeId: parts[4] } : {}) });
  }
}

export interface AgentNodeSource {
  readonly graphId: string;
  readonly nodeId: string;
  readonly path: string;
  /** Expanded invocation path, including this leaf. Distinguishes reused Subgraphs. */
  readonly invocationPath: readonly string[];
}

export function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}
