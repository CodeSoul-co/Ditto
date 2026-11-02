import schema from "./agent.schema.json" with { type: "json" };

/** Draft 2020-12 structural schema; semantic checks are performed by validateAgent. */
export const agentSchema: Readonly<Record<string, unknown>> = schema;
