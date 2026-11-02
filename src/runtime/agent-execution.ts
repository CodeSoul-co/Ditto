import { randomUUID } from "node:crypto";
import type { JsonValue } from "../contracts/common.js";
import type { LoopRunOptions } from "./runtime.js";
import { graphStep, type AsyncGraphPlan, type GraphPlan } from "./graph-plan.js";
import type { ExecutionGraph } from "./graph.js";
import { checkpointState, restoreState, stateDigest, type GraphCheckpoint, type StateCheckpoint } from "./checkpoint.js";
import { boolean, fields, record, snapshot } from "./agent-expression.js";

export interface AgentCheckpointState {
  readonly definitionHash: string;
  readonly inputHash: string;
  /** Number of completed Graph steps; never reset by resume. */
  readonly iteration: number;
  readonly step: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly phase: "ready" | "running" | "boundary" | "completed";
  readonly termination?: string;
  readonly graphCheckpoint?: GraphCheckpoint;
}
export type AgentCheckpoint = StateCheckpoint<AgentCheckpointState>;
export interface AgentCheckpointOptions {
  /** Stable execution ID. The host must enforce one writer (lease or CAS). */
  readonly id: string;
  /** Worker implementations and resource versions not represented in agent.json. */
  readonly version: string;
  readonly resume?: AgentCheckpoint;
  /** Must durably replace the latest checkpoint before resolving. Failure stops execution. */
  readonly save: (checkpoint: AgentCheckpoint) => void | Promise<void>;
}
export interface AgentBoundary {
  /** Stable across retries of this boundary; use for idempotent inbox decisions. */
  readonly id: string;
  readonly iteration: number;
  readonly step: string;
  readonly state: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
}
export interface AgentBoundaryDecision {
  /** Shallow state patch, applied after assign and before transition selection. */
  readonly update?: Readonly<Record<string, JsonValue>>;
  readonly pause?: boolean;
}
export interface AgentRunOptions extends Omit<LoopRunOptions, "checkpoint" | "stateCheckpoint"> {
  readonly stateCheckpoint?: AgentCheckpointOptions;
  /** Awaited after each Graph and assign. A failed hook is retried on resume with the same ID. */
  readonly onBoundary?: (boundary: AgentBoundary) => void | AgentBoundaryDecision | Promise<void | AgentBoundaryDecision>;
}
export class AgentPausedError extends Error {
  readonly code = "AGENT_PAUSED";
  constructor(readonly checkpoint: AgentCheckpoint) {
    super("Agent paused at a saved execution boundary");
    this.name = "AgentPausedError";
  }
}

/** Compiler-owned pure operations, shared by the public plan and durable executor. */
export interface AgentProgram {
  readonly entry: string;
  readonly maxIterations: number;
  initial(input: unknown): Readonly<Record<string, unknown>>;
  done(input: unknown, state: Readonly<Record<string, unknown>>): boolean;
  graph(step: string): string;
  input(step: string, input: unknown, state: Readonly<Record<string, unknown>>): unknown;
  assign(step: string, input: unknown, state: Readonly<Record<string, unknown>>, result: unknown): Readonly<Record<string, unknown>>;
  next(step: string, input: unknown, state: Readonly<Record<string, unknown>>, result: unknown): { next?: string; end?: string };
  output(input: unknown, frame: AgentCheckpointState): unknown;
}
type Graphs = Readonly<Record<string, ExecutionGraph<unknown, Record<string, unknown>>>>;
type Project = (graph: string, input: unknown, output: unknown) => unknown;

export function* agentPlan(program: AgentProgram, graphs: Graphs, project: Project, input: unknown): GraphPlan<unknown> {
  let frame: AgentCheckpointState = { definitionHash: "", inputHash: "", iteration: 0,
    step: program.entry, state: program.initial(input), result: null, phase: "ready" };
  while (!program.done(input, frame.state)) {
    if (frame.iteration >= program.maxIterations) throw new Error("Loop iteration limit reached");
    const graph = program.graph(frame.step), value = program.input(frame.step, input, frame.state);
    const result = project(graph, value, yield* graphStep(graphs[graph]!, value));
    frame = { ...frame, state: program.assign(frame.step, input, frame.state, result), result, iteration: frame.iteration + 1 };
    const transition = program.next(frame.step, input, frame.state, result);
    if (transition.end) return program.output(input, { ...frame, termination: transition.end });
    frame = { ...frame, step: transition.next! };
  }
  return program.output(input, { ...frame, termination: "completed" });
}

export async function* executeAgent(
  program: AgentProgram, graphs: Graphs, project: Project, definitionHash: string, input: unknown, options: AgentRunOptions,
): AsyncGraphPlan<unknown> {
  const checkpoint = options.stateCheckpoint, executionId = checkpoint?.id ?? randomUUID();
  if (checkpoint && (!checkpoint.id.trim() || !checkpoint.version.trim())) throw new Error("Checkpoint ID and version are required");
  const scope = `agent:${executionId}`, inputHash = checkpoint ? stateDigest(input) : "";
  let frame: AgentCheckpointState = checkpoint?.resume ? restoreState(checkpoint.resume, scope, checkpoint.version)
    : { definitionHash, inputHash, iteration: 0, step: program.entry, state: program.initial(input), result: null, phase: "ready" };
  if (frame.definitionHash !== definitionHash || frame.inputHash !== inputHash)
    throw new Error("Agent checkpoint definition or input is incompatible");
  if (!Number.isSafeInteger(frame.iteration) || frame.iteration < 0 || frame.iteration > program.maxIterations
    || !["ready", "running", "boundary", "completed"].includes(frame.phase)
    || (frame.phase === "running" && !frame.graphCheckpoint)) throw new Error("Invalid Agent checkpoint execution state");
  program.graph(frame.step); // Validate the cursor before any work, including completed resumes.
  const save = async (): Promise<AgentCheckpoint | undefined> => {
    if (!checkpoint) return undefined;
    const saved = checkpointState(scope, checkpoint.version, frame);
    await checkpoint.save(saved);
    return saved;
  };
  while (frame.phase !== "completed") {
    options.signal?.throwIfAborted();
    if (frame.phase === "ready") {
      if (program.done(input, frame.state)) {
        frame = { ...frame, phase: "completed", termination: "completed" };
        await save(); break;
      }
      if (frame.iteration >= program.maxIterations) throw new Error("Loop iteration limit reached");
    }
    if (frame.phase !== "boundary") {
      const key = program.graph(frame.step), value = program.input(frame.step, input, frame.state);
      const outputs = yield { kind: "graph", graph: graphs[key]!, input: value, options: checkpoint ? { checkpoint: {
        version: stateDigest([definitionHash, checkpoint.version]),
        ...(frame.graphCheckpoint ? { resume: frame.graphCheckpoint } : {}),
        save: async graphCheckpoint => {
          frame = { ...frame, phase: "running", graphCheckpoint };
          await save();
        },
      } } : {} };
      const result = project(key, value, outputs);
      const { graphCheckpoint: _previous, ...completed } = frame;
      frame = { ...completed, state: program.assign(frame.step, input, frame.state, result), result,
        iteration: frame.iteration + 1, phase: "boundary" };
      await save();
    }
    const decision = await options.onBoundary?.(Object.freeze({ id: `${executionId}:${frame.iteration}`, iteration: frame.iteration,
      step: frame.step, state: snapshot(frame.state) as Record<string, JsonValue>, result: snapshot(frame.result) }));
    options.signal?.throwIfAborted();
    if (decision !== undefined) {
      fields(record(decision, "/boundary"), ["update", "pause"], "/boundary");
      if (decision.pause !== undefined) boolean(decision.pause, "/boundary/pause");
    }
    if (decision?.pause && !checkpoint) throw new Error("Pausing requires an Agent stateCheckpoint");
    if (decision?.update !== undefined)
      frame = { ...frame, state: { ...frame.state, ...record(snapshot(decision.update), "/boundary/update") } };
    const transition = program.next(frame.step, input, frame.state, frame.result);
    frame = transition.end ? { ...frame, phase: "completed", termination: transition.end }
      : { ...frame, phase: "ready", step: transition.next! };
    const saved = await save();
    if (decision?.pause) throw new AgentPausedError(saved!);
  }
  return program.output(input, frame);
}
