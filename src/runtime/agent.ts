/**
 * agent.json defines structure and application parameters. createAgent() defaults
 * to ./ditto.yaml + process.env through Runtime; explicit options.config wins.
 * compileAgent() stays pure and does not read configuration files.
 * definition.config is only expression data, separate from Runtime config.
 * With loop, maxIterations is required and overrides the Runtime fallback;
 * without loop, main runs once. run(input, { concurrency }) overrides the Runtime default.
 * Node inputs override supported Worker defaults, never host permission grants.
 */
import type { JsonValue, NodeType } from "../contracts/index.js";
import { isDeepStrictEqual } from "node:util";
import type { WorkerDefinition } from "../worker/define-worker.js";
import { ExecutionGraph } from "./graph.js";
import { graphStep, type GraphPlan, type LoopPlanDefinition } from "./graph-plan.js";
import { createDitto, type DittoOptions, type DittoRuntime, type LoopRunOptions, type WorkerRegistrationOptions } from "./runtime.js";
import { boolean, expression, fail, fields, lookup, name, pathParts, positive, record, snapshot, type Expression } from "./agent-expression.js";

/** JSON expressions: literals, {$ref, default?}, {$op, args}, {$map:{items,value}}, {$literal}. */
export type AgentExpression = JsonValue;
export interface AgentNode {
  readonly id: string;
  readonly kind?: "node";
  readonly type: string;
  readonly dependsOn?: readonly string[];
  readonly input: AgentExpression;
  readonly require?: { readonly path: string; readonly equals: JsonValue };
}
export interface AgentSubgraph {
  readonly id: string;
  readonly kind: "subgraph";
  readonly graph: string;
  readonly dependsOn?: readonly string[];
  readonly input: AgentExpression;
}
export interface AgentGraph {
  readonly nodes: readonly (AgentNode | AgentSubgraph)[];
  readonly output?: AgentExpression;
}
export interface AgentTransition {
  readonly when?: AgentExpression;
  readonly next?: string;
  readonly end?: string;
}
export interface AgentLoopStep {
  readonly graph: string;
  readonly input: AgentExpression;
  readonly assign?: Readonly<Record<string, AgentExpression>>;
  readonly transitions: readonly AgentTransition[];
}
export interface AgentLoop {
  readonly entry: string;
  readonly maxIterations: number;
  readonly state: AgentExpression;
  /** Checked before each Graph. False permits zero iterations. */
  readonly while?: AgentExpression;
  readonly steps: Readonly<Record<string, AgentLoopStep>>;
  readonly output?: AgentExpression;
}
export interface AgentDefinition {
  readonly version: 1;
  readonly id: string;
  readonly graphs: Readonly<Record<string, AgentGraph>>;
  /** Without a Loop, execute main once. */
  readonly entry?: "main";
  readonly loop?: AgentLoop;
  /** Non-secret values available to expressions as config.*. */
  readonly config?: JsonValue;
  readonly deployment?: AgentDeployment;
}
export interface AgentDeployment {
  /** Aliases into a trusted host registry, not import paths or factories. */
  readonly workers?: readonly { readonly id: string; readonly use: string; readonly services?: string }[];
  /** Graph ID -> expanded leaf ID (e.g. research/search) -> Worker instance ID. */
  readonly bindings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface AgentWorker {
  readonly definition: WorkerDefinition;
  readonly services?: WorkerRegistrationOptions["services"];
}
export interface CreateAgentOptions extends Omit<DittoOptions, "workers"> {
  readonly workers: Readonly<Record<string, WorkerDefinition | AgentWorker>>;
  /** Only these host-authorized resource/permission profiles can be selected by JSON. */
  readonly serviceProfiles?: Readonly<Record<string, NonNullable<WorkerRegistrationOptions["services"]>>>;
}
export interface CompiledAgent {
  readonly definition: AgentDefinition;
  readonly graphs: Readonly<Record<string, ExecutionGraph<unknown, Record<string, unknown>>>>;
  readonly plan: LoopPlanDefinition<unknown, unknown>;
  /** Preflight every graph and binding before starting any work. Runtime remains host-owned. */
  run(runtime: DittoRuntime, input: unknown, options?: LoopRunOptions): Promise<unknown>;
}
export interface ConfiguredAgent {
  readonly compiled: CompiledAgent;
  readonly runtime: DittoRuntime;
  run(input: unknown, options?: Omit<LoopRunOptions, "workers">): Promise<unknown>;
  close(): Promise<void>;
}

type Outputs = Readonly<Record<string, unknown>>;
type Resolver = (input: unknown, outputs: Outputs) => unknown;
interface Projection { readonly leaves: readonly string[]; readonly requiresInput: boolean; readonly resolve: Resolver }
interface FlatNode {
  id: string; type: NodeType; dependencies: readonly string[]; bind: Resolver;
  validate?: (output: unknown) => void;
}
interface ParsedNode {
  id: string; type?: string; child?: string; dependencies: readonly string[]; input: Expression;
  validate?: (output: unknown) => void;
}
interface ParsedGraph { nodes: readonly ParsedNode[]; output: Expression; outputReferences: ReadonlySet<string> }

/** Resolve only the projected fields, once per expression evaluation. */
function lazyScope(entries: readonly (readonly [string, () => unknown])[]): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  for (const [key, resolve] of entries) Object.defineProperty(scope, key, {
    enumerable: true, configurable: true,
    get() {
      const value = resolve();
      Object.defineProperty(scope, key, { value, enumerable: true });
      return value;
    },
  });
  return scope;
}

/** Compile JSON into the existing DAG scheduler and one outer Loop, without eval or SDK calls. */
export function compileAgent(source: unknown): CompiledAgent {
  const json = snapshot(source), root = record(json, "definition");
  fields(root, ["version", "id", "graphs", "entry", "loop", "config", "deployment"], "definition");
  if (root.version !== 1) fail("version", "expected 1");
  const id = name(root.id, "id");
  const config = root.config === undefined ? {} : root.config;
  const expr = (value: unknown, roots: readonly string[], where: string, dependencies?: readonly string[], references?: Set<string>): Expression => {
    const evaluate = expression(value, [...roots, "config"], where, dependencies, references);
    // Scopes are fresh compiler-owned objects; keep lazy properties intact.
    return scope => evaluate(Object.assign(scope, { config }));
  };
  const deployment = parseDeployment(root.deployment === undefined ? {} : root.deployment);
  if (root.entry !== undefined && (root.entry !== "main" || root.loop !== undefined)) fail(id, "entry must be main and cannot accompany loop");
  const definitions = record(root.graphs, "graphs");
  if (!Object.hasOwn(definitions, "main")) fail("graphs", "a main Graph is required");
  const parsed = new Map<string, ParsedGraph>();
  for (const [graphId, raw] of Object.entries(definitions)) {
    name(graphId, "graph ID");
    const body = record(raw, graphId);
    fields(body, ["nodes", "output"], graphId);
    if (!Array.isArray(body.nodes) || !body.nodes.length) fail(graphId, "nodes must be a nonempty array");
    const nodes = new Map<string, ParsedNode>();
    for (const rawNode of body.nodes) {
      const node = record(rawNode, graphId), nodeId = name(node.id, `${graphId}.node.id`), where = `${graphId}/${nodeId}`;
      fields(node, ["id", "kind", "type", "graph", "dependsOn", "input", "require"], where);
      if (nodes.has(nodeId)) fail(where, "duplicate node ID");
      if (node.kind !== undefined && node.kind !== "node" && node.kind !== "subgraph") fail(where, "invalid kind");
      const dependencies = node.dependsOn === undefined ? [] : node.dependsOn;
      if (!Array.isArray(dependencies)) fail(where, "dependsOn must be an array");
      const deps = dependencies.map(d => name(d, where));
      if (new Set(deps).size !== deps.length) fail(where, "duplicate dependency");
      if (!Object.hasOwn(node, "input")) fail(where, "input is required");
      const input = expr(node.input, ["input", "nodes"], `${where}.input`, deps);
      if (node.kind === "subgraph") {
        if (node.type !== undefined || node.require !== undefined) fail(where, "subgraphs accept graph, not type or require");
        const child = name(node.graph, where);
        if (!Object.hasOwn(definitions, child)) fail(where, `unknown subgraph ${child}`);
        nodes.set(nodeId, { id: nodeId, child, dependencies: deps, input });
      } else {
        if (node.graph !== undefined || typeof node.type !== "string" || !/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+$/.test(node.type))
          fail(where, "expected a qualified Node type");
        let validate: ((output: unknown) => void) | undefined;
        if (node.require !== undefined) {
          const requirement = record(node.require, where);
          fields(requirement, ["path", "equals"], where);
          if (!Object.hasOwn(requirement, "equals")) fail(where, "require.equals is required");
          const path = pathParts(requirement.path, where);
          validate = output => { if (!isDeepStrictEqual(lookup(output, path), requirement.equals)) fail(where, `output requirement failed: ${String(requirement.path)}`); };
        }
        nodes.set(nodeId, { id: nodeId, type: node.type, dependencies: deps, input, ...(validate ? { validate } : {}) });
      }
    }
    // Accept canvas order; topologically sort once rather than requiring declaration order.
    const sorted: ParsedNode[] = [], remaining = new Map<string, number>(), children = new Map<string, string[]>();
    for (const node of nodes.values()) {
      remaining.set(node.id, node.dependencies.length);
      if (!node.dependencies.length) sorted.push(node);
      for (const dependency of node.dependencies) {
        if (!nodes.has(dependency)) fail(graphId, `unknown dependency ${dependency}`);
        const list = children.get(dependency) ?? [];
        list.push(node.id); children.set(dependency, list);
      }
    }
    for (let i = 0; i < sorted.length; i++) for (const child of children.get(sorted[i]!.id) ?? []) {
      const pending = remaining.get(child)! - 1;
      remaining.set(child, pending);
      if (!pending) sorted.push(nodes.get(child)!);
    }
    if (sorted.length !== nodes.size) fail(graphId, "cyclic dependency; use Loop for cycles");
    const hasOutput = Object.hasOwn(body, "output");
    const outputReferences = new Set<string>(hasOutput ? [] : ["nodes"]);
    const output = hasOutput
      ? expr(body.output, ["input", "nodes"], `${graphId}.output`, [...nodes.keys()], outputReferences)
      : (scope: Outputs) => ({ ...(scope.nodes as Outputs) });
    parsed.set(graphId, { nodes: sorted, output, outputReferences });
  }

  const graphs: Record<string, ExecutionGraph<unknown, Record<string, unknown>>> = {};
  const projections = new Map<string, Resolver>();
  let totalLeaves = 0;
  for (const graphId of parsed.keys()) {
    const flat: FlatNode[] = [];
    function expand(key: string, prefix: string, getInput: Resolver, inherited: readonly string[], stack: readonly string[]): Projection {
      if (stack.includes(key) || stack.length >= 32) fail(key, "recursive or excessively nested subgraph");
      const body = parsed.get(key)!, logical = new Map<string, Projection>();
      const start = flat.length;
      for (const node of body.nodes) {
        const expandedId = `${prefix}${node.id}`;
        const dependencies = [...new Set([...inherited, ...node.dependencies.flatMap(d => logical.get(d)!.leaves)])];
        // Capture only declared dependencies; later siblings never enter this scope.
        const upstream = node.dependencies.map(d => [d, logical.get(d)!.resolve] as const);
        const bind: Resolver = (input, outputs) => node.input({
          input: getInput(input, outputs),
          nodes: Object.fromEntries(upstream.map(([key, resolve]) => [key, resolve(input, outputs)])),
        });
        let projected: Projection;
        if (node.child) projected = expand(node.child, `${expandedId}/`, bind, dependencies, [...stack, key]);
        else {
          if (++totalLeaves > 20_000) fail(graphId, "expanded node limit exceeded");
          flat.push({ id: expandedId, type: node.type as NodeType, dependencies, bind,
            ...(node.validate ? { validate: node.validate } : {}) });
          projected = { leaves: [expandedId], requiresInput: false, resolve: (_input, outputs) => outputs[expandedId] };
        }
        logical.set(node.id, projected);
      }
      const entries = [...logical], refs = body.outputReferences;
      const requiresInput = refs.has("input") || entries.some(([key, p]) => p.requiresInput && (refs.has("nodes") || refs.has(`nodes.${key}`)));
      // Own leaves already impose completion barriers. Ancestors are needed only to project input-derived outputs.
      const leaves = flat.slice(start).map(node => node.id);
      return { leaves: requiresInput ? [...new Set([...inherited, ...leaves])] : leaves, requiresInput,
        resolve: (input, outputs) => body.output(lazyScope([
          ["input", () => getInput(input, outputs)],
          ["nodes", () => lazyScope(entries.map(([key, p]) => [key, () => p.resolve(input, outputs)] as const))],
        ])),
      };
    }
    const projection = expand(graphId, "", input => input, [], []);
    const plan = ExecutionGraph.fromTasks<unknown>(graphId, flat.map(node => ({
      id: node.id, node: node.type, dependencies: node.dependencies, bind: node.bind,
      ...(node.validate ? { validateOutput: node.validate } : {}),
    })));
    graphs[graphId] = plan;
    projections.set(graphId, projection.resolve);
  }
  function* execute(key: string, input: unknown): GraphPlan<unknown> {
    const outputs = yield* graphStep(graphs[key]!, input);
    return projections.get(key)!(input, outputs);
  }
  let plan: LoopPlanDefinition<unknown, unknown>;
  if (root.loop === undefined) {
    plan = { id, maxIterations: 1, plan: input => execute("main", input) };
  } else {
    const loop = record(root.loop, "loop");
    fields(loop, ["entry", "maxIterations", "state", "while", "steps", "output"], "loop");
    const entry = name(loop.entry, "loop.entry"), maxIterations = positive(loop.maxIterations, "loop.maxIterations");
    if (!Object.hasOwn(loop, "state")) fail("loop", "state is required");
    const initial = expr(loop.state, ["input"], "loop.state");
    const condition = loop.while === undefined ? undefined : expr(loop.while, ["input", "state"], "loop.while");
    const definitions = record(loop.steps, "loop.steps");
    const steps = new Map<string, { graph: string; input: Expression; assign: Expression;
      transitions: { when?: Expression; next?: string; end?: string }[] }>();
    for (const [key, raw] of Object.entries(definitions)) {
      name(key, "step ID");
      const step = record(raw, `step ${key}`);
      fields(step, ["graph", "input", "assign", "transitions"], key);
      const target = name(step.graph, key);
      if (!parsed.has(target)) fail(key, `unknown Graph ${target}`);
      if (!Object.hasOwn(step, "input")) fail(key, "input is required");
      const input = expr(step.input, ["input", "state"], `${key}.input`);
      const updates = record(step.assign === undefined ? {} : step.assign, `${key}.assign`);
      for (const field of Object.keys(updates)) name(field, `${key}.assign`);
      const assign = expr(updates, ["input", "state", "result"], `${key}.assign`);
      if (!Array.isArray(step.transitions) || !step.transitions.length) fail(key, "transitions must be nonempty");
      const transitions = step.transitions.map((raw, i) => {
        const t = record(raw, key);
        fields(t, ["when", "next", "end"], key);
        if (Object.hasOwn(t, "next") === Object.hasOwn(t, "end")) fail(key, "transition needs exactly one of next and end");
        if (t.when === undefined && i !== (step.transitions as unknown[]).length - 1) fail(key, "default transition must be last");
        const when = t.when === undefined ? undefined : expr(t.when, ["input", "state", "result"], `${key}.when`);
        if (t.next !== undefined) {
          const next = name(t.next, key);
          if (!Object.hasOwn(definitions, next)) fail(key, `unknown next step ${next}`);
          return { ...(when ? { when } : {}), next };
        }
        return { ...(when ? { when } : {}), end: name(t.end, key) };
      });
      if (transitions.at(-1)!.when) fail(key, "last transition must be an unconditional default");
      steps.set(key, { graph: target, input, assign, transitions });
    }
    if (!steps.has(entry)) fail("loop.entry", "unknown step");
    if (steps.get(entry)!.graph !== "main") fail("loop.entry", "first step must execute the main Graph");
    const output = loop.output === undefined ? (scope: Readonly<Record<string, unknown>>) => scope.state
      : expr(loop.output, ["input", "state", "result", "termination"], "loop.output");
    plan = { id, maxIterations, *plan(input) {
      let state = record(initial({ input }), "loop.state"), current = entry, result: unknown = null;
      while (true) {
        if (condition && !boolean(condition({ input, state }), "loop.while"))
          return output({ input, state, result, termination: { reason: "completed" } });
        const step = steps.get(current)!;
        result = yield* execute(step.graph, step.input({ input, state }));
        state = { ...state, ...record(step.assign({ input, state, result }), `${current}.assign`) };
        const transition = step.transitions.find(t => !t.when || boolean(t.when({ input, state, result }), `${current}.when`))!;
        if (transition.end) return output({ input, state, result, termination: { reason: transition.end } });
        current = transition.next!;
      }
    } };
  }
  const compiled: CompiledAgent = Object.freeze({
    definition: json as unknown as AgentDefinition, graphs: Object.freeze(graphs), plan: Object.freeze(plan),
    async run(runtime: DittoRuntime, input: unknown, options: LoopRunOptions = {}) {
      if (options.checkpoint || options.stateCheckpoint) fail(id, "compiled plans do not serialize generator checkpoints");
      const workers = options.workers ?? deployment.bindings ?? {};
      preflight(graphs, runtime.workers().map(w => ({ id: w.address.workerId, capabilities: w.capabilities })), workers);
      return runtime.loop(plan, input, { ...options, workers });
    },
  });
  return compiled;
}

function parseDeployment(raw: unknown): AgentDeployment {
  const deployment = record(raw, "deployment");
  fields(deployment, ["workers", "bindings"], "deployment");
  const bindings = record(deployment.bindings === undefined ? {} : deployment.bindings, "bindings");
  for (const [key, raw] of Object.entries(bindings)) {
    name(key, "binding Graph");
    for (const value of Object.values(record(raw, key))) name(value, "Worker binding");
  }
  if (deployment.workers !== undefined) {
    if (!Array.isArray(deployment.workers)) fail("deployment.workers", "expected an array");
    const ids = new Set<string>();
    for (const raw of deployment.workers) {
      const entry = record(raw, "deployment.workers");
      fields(entry, ["id", "use", "services"], "deployment.workers");
      const id = name(entry.id, "Worker id");
      name(entry.use, "Worker registry key");
      if (entry.services !== undefined) name(entry.services, "Worker services profile");
      if (ids.has(id)) fail(id, "duplicate Worker ID");
      ids.add(id);
    }
  }
  return deployment as AgentDeployment;
}

function preflight(graphs: CompiledAgent["graphs"], workers: readonly { id: string; capabilities: readonly string[] }[], bindings: NonNullable<AgentDeployment["bindings"]>): void {
  const providers = new Map<string, Set<string>>();
  for (const worker of workers) for (const node of worker.capabilities) {
    let ids = providers.get(node);
    if (!ids) { ids = new Set(); providers.set(node, ids); }
    ids.add(worker.id);
  }
  for (const key of Object.keys(bindings)) if (!Object.hasOwn(graphs, key)) fail("bindings", `unknown Graph ${key}`);
  for (const [key, graph] of Object.entries(graphs)) {
    const mapping = bindings[key] ?? {};
    const nodes = new Set(graph.tasks.map(t => t.id));
    for (const nodeId of Object.keys(mapping)) if (!nodes.has(nodeId)) fail("bindings", `unknown node ${key}/${nodeId}`);
    for (const task of graph.tasks) {
      const selected = mapping[task.id];
      const available = providers.get(task.node);
      if (!available || (selected !== undefined && !available.has(selected)))
        fail(`${key}/${task.id}`, `no registered Worker exposes ${task.node}${selected === undefined ? "" : ` at ${selected}`}`);
    }
  }
}

/** Register trusted definitions separately from JSON structure. Owns and closes its Runtime. */
export async function createAgent(source: unknown, options: CreateAgentOptions): Promise<ConfiguredAgent> {
  const compiled = compileAgent(source);
  const { workers: registry, serviceProfiles = {}, ...runtimeOptions } = options;
  const deployment = compiled.definition.deployment ?? {};
  const bindings = deployment.bindings ?? {};
  const requested = deployment.workers ?? Object.keys(registry).map(id => ({ id, use: id }));
  const registrations = requested.map(raw => {
    const entry = record(raw, "deployment.workers");
    const id = name(entry.id, "Worker id"), use = name(entry.use, "Worker registry key");
    if (!Object.hasOwn(registry, use)) fail(use, "unknown host Worker definition");
    const registered = registry[use]!;
    const descriptor: AgentWorker = "definition" in registered ? registered : { definition: registered };
    const profile = entry.services === undefined ? undefined : name(entry.services, "Worker services profile");
    if (profile && !Object.hasOwn(serviceProfiles, profile)) fail(profile, "unknown host services profile");
    return { id, ...descriptor, ...(profile ? { services: serviceProfiles[profile]! } : {}) };
  });
  const workerBindings = bindings as NonNullable<AgentDeployment["bindings"]>;
  preflight(compiled.graphs, registrations.map(w => ({ id: w.id, capabilities: w.definition.capabilities })), workerBindings);
  const runtime = createDitto(runtimeOptions);
  try {
    for (const worker of registrations) runtime.register(worker.definition, { id: worker.id,
      ...(worker.services ? { services: worker.services } : {}) });
  } catch (error) {
    await runtime.close().catch(() => {});
    throw error;
  }
  return Object.freeze({ compiled, runtime,
    run: (input: unknown, runOptions: Omit<LoopRunOptions, "workers"> = {}) => compiled.run(runtime, input, { ...runOptions, workers: workerBindings }),
    close: () => runtime.close(),
  });
}
