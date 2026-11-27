import { randomUUID } from "node:crypto";
import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";
import type { RuntimeClient, WorkerContext } from "../worker/node.js";
import type { WorkerDefinition } from "../worker/define-worker.js";
import { executionReporter, graphOperation, type ExecutionAttempt, type ExecutionObserver, type ExecutionReporter, type RecoveryPolicy } from "./execution-events.js";
import type { Usage } from "../worker/infer/types.js";
import { PayloadCodec, type ArtifactStore } from "./artifact.js";
import { LocalEventFabric, type EventFabric, type EventHandler, type RuntimeEvent } from "./communication/events.js";
import { graph, runGraph, type ExecutionGraph, type GraphRunOptions } from "./graph.js";
import { runGraphPlan, type LoopPlanDefinition, type AsyncLoopPlanDefinition, type LoopGraphEvent } from "./graph-plan.js";
import { runLoop, type LoopDefinition } from "./loop.js";
import type { LoopCheckpointOptions } from "./checkpoint.js";
import { NoWorkerAvailableError, WorkerRouter, isWorkerAvailable, type WorkerEntry } from "./router.js";
import { TransportError } from "./communication/transport.js";
import { createRuntimeServices, type RuntimeServices, type RuntimeServiceOptions } from "./services.js";
import type {
  ExecutionScope, InvocationEnvelope, InvocationResult, InvokeOptions, InvokeTransport, RemoteWorker, WorkerAddress,
} from "./communication/transport.js";

interface InvocationSite {
  readonly parent?: ExecutionScope;
  readonly source?: WorkerAddress;
  /** Graph scheduler owns output validation and commit. */
  readonly task?: ExecutionScope;
  readonly onAcceptedAttempt?: (attempt: ExecutionAttempt) => void;
  /** Private Worker subgraphs execute within their parent's capacity slot. */
  readonly owner?: WorkerEntry;
}

const recoverableCodes = new Set(["CHANNEL_CLOSED", "WORKER_EXITED", "COMMUNICATION_ERROR", "TIMEOUT"]);

export interface DittoOptions extends RuntimeServiceOptions {
  readonly workers?: readonly WorkerDefinition[];
  readonly hostId?: string;
  readonly processId?: string;
  readonly transports?: readonly InvokeTransport[];
  readonly events?: EventFabric;
  readonly onExecutionEvent?: ExecutionObserver;
  readonly recoveryPolicy?: RecoveryPolicy;
  readonly artifacts?: ArtifactStore;
  readonly inlineLimitBytes?: number;
}

/** Deployment choices belong to execution, not to a reusable graph. */
export interface RunOptions extends GraphRunOptions {
  readonly workers?: Readonly<Record<string, string>>;
}
export interface LoopRunOptions extends Omit<GraphRunOptions, "runId"> {
  readonly stateCheckpoint?: LoopCheckpointOptions;
  readonly onGraph?: (event: LoopGraphEvent) => void;
  readonly workers?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface WorkerRegistrationOptions {
  readonly id?: string;
  /** Omit to share Runtime services; inject a separate instance for isolation. */
  readonly services?: RuntimeServices;
}

export interface WorkerHandle {
  readonly address: WorkerAddress;
  setAvailable(available: boolean): void;
  unregister(): boolean;
  /** Stop routing, drain accepted invocations, then dispose resources once. */
  close(): Promise<void>;
}

export class DittoRuntime implements RuntimeClient {
  readonly hostId: string;
  readonly processId: string;
  readonly services: RuntimeServices;
  readonly reportExecution: ExecutionReporter | undefined;
  readonly #recovery: RecoveryPolicy | undefined;
  readonly #workers = new Map<string, WorkerEntry>();
  readonly #transports = new Map<string, InvokeTransport>();
  readonly #router = new WorkerRouter();
  readonly #codec: PayloadCodec;
  readonly #events: EventFabric;
  readonly #closers = new Set<() => Promise<void>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #subscriptions = new Set<() => boolean>();

  constructor(options: DittoOptions = {}) {
    this.hostId = options.hostId ?? "local";
    this.processId = options.processId ?? randomUUID();
    this.reportExecution = options.onExecutionEvent && executionReporter(options.onExecutionEvent);
    this.#recovery = options.recoveryPolicy;
    if (this.#recovery && (!Number.isSafeInteger(this.#recovery.maxAttempts) || this.#recovery.maxAttempts < 1))
      throw new Error("recoveryPolicy.maxAttempts must be a positive integer");
    this.services = createRuntimeServices(options);
    this.#codec = new PayloadCodec(options.artifacts, options.inlineLimitBytes);
    this.#events = options.events ?? new LocalEventFabric();
    for (const transport of options.transports ?? []) {
      if (!transport.id || this.#transports.has(transport.id)) {
        throw new Error(`Duplicate or empty Transport ID: ${transport.id}`);
      }
      this.#transports.set(transport.id, transport);
    }
    for (const worker of options.workers ?? []) this.register(worker);
  }

  register(worker: WorkerDefinition, options: string | WorkerRegistrationOptions = {}): WorkerHandle {
    const { id: workerId = randomUUID(), services = this.services } = typeof options === "string" ? { id: options } : options;
    this.#checkId(workerId);
    const address = Object.freeze({
      workerId, workerType: worker.type, hostId: this.hostId, processId: this.processId,
    });
    const entry: WorkerEntry = {
      address, capabilities: this.#capabilities(address, worker.capabilities),
      nodeTypes: this.#capabilities(address, worker.nodeTypes ?? worker.capabilities),
      executor: worker.instantiate(), services, available: true,
      concurrency: worker.concurrency ?? Infinity, active: 0, pending: new Set(),
    };
    return this.#add(entry);
  }

  registerRemote(worker: RemoteWorker): WorkerHandle {
    this.#checkId(worker.address.workerId);
    const transport = this.#transports.get(worker.transportId);
    if (!transport) {
      throw new Error(`Transport is not installed: ${worker.transportId}`);
    }
    if (worker.address.hostId === this.hostId && worker.address.processId === this.processId) {
      throw new Error("Use register for Workers in the current process");
    }
    if (worker.concurrency !== undefined && (!Number.isSafeInteger(worker.concurrency) || worker.concurrency < 1)) {
      throw new Error("Worker concurrency must be a positive integer");
    }
    return this.#add({
      address: Object.freeze({ ...worker.address }),
      capabilities: this.#capabilities(worker.address, worker.capabilities),
      transport, available: true,
      concurrency: worker.concurrency ?? Infinity, active: 0, pending: new Set(),
    });
  }

  workers(): readonly { address: WorkerAddress; capabilities: readonly NodeType[]; available: boolean; active: number; concurrency: number }[] {
    return [...this.#workers.values()].map(entry => ({
      address: entry.address, capabilities: entry.capabilities, available: isWorkerAvailable(entry),
      active: entry.active, concurrency: entry.concurrency,
    }));
  }

  async invoke<N extends NodeType>(node: N, input: InputOf<NoInfer<N>>, options: InvokeOptions = {}): Promise<OutputOf<N>> {
    this.#assertOpen();
    return this.#operation(() => this.#invoke(node, input, options)) as Promise<OutputOf<N>>;
  }

  async emit<T>(event: RuntimeEvent<T>): Promise<void> {
    this.#assertOpen();
    return this.#operation(() => this.#events.emit(event));
  }

  subscribe(type: string, handler: EventHandler): () => boolean {
    this.#assertOpen();
    const remove = this.#events.subscribe(type, event => this.#operation(async () => { await handler(event); }));
    const unsubscribe = (): boolean => { this.#subscriptions.delete(unsubscribe); return remove(); };
    this.#subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  /** Wait for accepted events, returning consumer failures separately from emit. */
  drainEvents(): ReturnType<EventFabric["drain"]> {
    return this.#events.drain();
  }

  graph<I>(id = "agent"): ExecutionGraph<I> {
    return graph<I>(id);
  }

  async run<I, O extends object>(plan: ExecutionGraph<I, O>, input: NoInfer<I>, options: RunOptions = {}): Promise<O> {
    this.#assertOpen();
    return this.#operation(() => this.#run(plan, input, options));
  }

  async loop<I, R>(
    definition: LoopPlanDefinition<I, R> | AsyncLoopPlanDefinition<I, R>,
    input: NoInfer<I>,
    options?: LoopRunOptions,
  ): Promise<R>;
  async loop<S, I, O extends object>(
    definition: LoopDefinition<S, I, O>,
    initialState: NoInfer<S>,
    options?: LoopRunOptions,
  ): Promise<S>;
  async loop<S, I, O extends object, R>(
    definition: LoopDefinition<S, I, O> | LoopPlanDefinition<S, R> | AsyncLoopPlanDefinition<S, R>,
    initialState: NoInfer<S>,
    options: LoopRunOptions = {},
  ): Promise<S | R> {
    this.#assertOpen();
    if (options.checkpoint) throw new Error("Use per-Graph checkpoints or a Loop stateCheckpoint");
    if ("plan" in definition && options.stateCheckpoint) throw new Error("Generator Loop checkpoints are unsupported; use an explicit state Loop");
    const executionId = options.stateCheckpoint?.id ?? options.executionId ?? (this.reportExecution && randomUUID());
    if ("plan" in definition)
      return this.#operation(() =>
        runGraphPlan(
          {
            ...definition,
            maxIterations:
              definition.maxIterations ??
              this.services.config.loopMaxIterations,
          },
          initialState,
          (plan, input, stepOptions) =>
            this.#run(plan, input, {
              ...options,
              ...(executionId && { executionId }),
              ...stepOptions,
              workers: options.workers?.[plan.id] ?? {},
              ...(options.signal
                ? {
                    signal: stepOptions.signal
                      ? AbortSignal.any([options.signal, stepOptions.signal])
                      : options.signal,
                  }
                : {}),
            }),
          options.signal,
          options.onGraph,
        ),
      );
    return this.#operation(() =>
      runLoop(
        {
          ...definition,
          maxIterations:
            definition.maxIterations ?? this.services.config.loopMaxIterations,
        },
        initialState,
        (plan, input, iteration) =>
          this.#run(plan, input, {
            ...options,
            ...(executionId && { executionId, runId: JSON.stringify([executionId, iteration]) }),
            workers: options.workers?.[plan.id] ?? {},
          }),
        options.signal,
        options.stateCheckpoint, this.reportExecution,
      ),
    );
  }

  #run<I, O extends object>(plan: ExecutionGraph<I, O>, input: I, options: RunOptions): Promise<O> {
    const bindings = new Map(Object.entries(options.workers ?? {}));
    const tasks = new Map(plan.tasks.map(task => [task.id, task]));
    for (const task of plan.tasks) if (task.bindingId && !bindings.has(task.id) && bindings.has(task.bindingId))
      bindings.set(task.id, bindings.get(task.bindingId)!);
    for (const [taskId, workerId] of bindings) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Unknown graph Node binding: ${taskId}`);
      if (!this.#workers.get(workerId)?.capabilities.includes(task.node)) {
        throw new Error(`Worker ${workerId} does not expose ${task.node}`);
      }
    }
    return runGraph(plan, input, (node, value, scope, onAcceptedAttempt) => this.#invoke(node, value, {
      ...(!bindings.has(scope.nodeId) ? {} : { workerId: bindings.get(scope.nodeId)! }),
      ...(options.signal ? { signal: options.signal } : {}),
    }, { task: scope, ...(onAcceptedAttempt && { onAcceptedAttempt }) }), { concurrency: this.services.config.graphConcurrency, ...options }, this.reportExecution);
  }

  /** Adapter-facing receiver. This is not an unauthenticated network server. */
  async receive(envelope: InvocationEnvelope): Promise<InvocationResult> {
    this.#assertOpen();
    const entry = this.#workers.get(envelope.target.workerId);
    if (!entry?.executor || !entry.available
      || entry.address.hostId !== envelope.target.hostId
      || entry.address.processId !== envelope.target.processId
      || entry.address.workerType !== envelope.target.workerType
      || !entry.capabilities.includes(envelope.node)) {
      throw new Error(`Invocation target unavailable or mismatched: ${envelope.target.workerId}`);
    }
    return this.#operation(() => this.#track(entry, async () => {
      const input = await this.#codec.decode(envelope.payload);
      const output = await entry.executor!.execute(envelope.node, input, this.#context(entry, envelope.execution, undefined,
        envelope.operationId ? { operationId: envelope.operationId, attemptId: envelope.id } : undefined));
      return { invocationId: envelope.id, payload: await this.#codec.encode(output) };
    }));
  }

  async #invoke(node: NodeType, input: unknown, options: InvokeOptions = {}, site: InvocationSite = {}): Promise<unknown> {
    if (this.#closed) throw new Error("Runtime is closed");
    options.signal?.throwIfAborted();
    let entry = site.owner ?? this.#router.select(node, this.#workers.values(), this.hostId, options.workerId);
    if (!entry) throw new NoWorkerAvailableError(node);
    const report = this.reportExecution, policy = this.#recovery;
    if (!report && !policy) return this.#dispatch(entry, node, input, site, options);

    const operation = site.task
      ? graphOperation(site.task, node)
      : { operationId: randomUUID(), node, ...(site.parent && { execution: site.parent }) };
    report?.({ type: "operation.dispatched", ...operation });
    let tried: Set<string> | undefined;
    for (let number = 1; ; number++) {
      const attempt = { ...operation, attemptId: randomUUID(), workerId: entry.address.workerId, attempt: number };
      report?.({ type: "attempt.started", ...attempt });
      try {
        const output = await this.#dispatch(entry, node, input, site, options, attempt);
        if (report) {
          const usage = node.startsWith("INFER.REASONING.") && (output as { output?: { usage?: Usage } } | null)?.output?.usage;
          report({ type: "attempt.succeeded", ...attempt, ...(usage && { usage: { ...usage } }) });
          if (site.task) site.onAcceptedAttempt?.(attempt);
          else report({ type: "operation.committed", ...attempt });
        }
        return output;
      } catch (error) {
        const transportFailure = error instanceof TransportError && error.invocationId === attempt.attemptId && !!entry.transport;
        report?.({ type: "attempt.failed", ...attempt, ...(transportFailure && { status: error.status, code: error.code }) });
        options.signal?.throwIfAborted();
        if (!policy || !transportFailure) throw error;
        let next: WorkerEntry | undefined;
        if (!options.workerId && number < policy.maxAttempts && recoverableCodes.has(error.code)) {
          const retry = policy.shouldRetry
            ? await policy.shouldRetry({ ...attempt, error, input, ...(options.signal && { signal: options.signal }) })
            : error.status === "not_sent";
          options.signal?.throwIfAborted();
          if (retry) {
            (tried ??= new Set()).add(entry.address.workerId);
            next = this.#router.select(node, this.#workers.values(), this.hostId, undefined, tried);
          }
        }
        report?.({ type: "recovery.decided", ...attempt, decision: next ? "retry" : "stop",
          ...(next && { nextWorkerId: next.address.workerId }) });
        if (!next) throw error;
        entry = next;
      }
    }
  }

  #dispatch(entry: WorkerEntry, node: NodeType, input: unknown, site: InvocationSite,
    options: InvokeOptions, invocation?: WorkerContext["invocation"]): Promise<unknown> {
    const execution = site.task ?? site.parent;
    if (entry.executor) {
      const execute = async () => {
        options.signal?.throwIfAborted();
        const result = await entry.executor!.execute(node, input, this.#context(entry, execution, options.signal, invocation));
        options.signal?.throwIfAborted();
        return result;
      };
      return site.owner ? execute() : this.#track(entry, execute);
    }
    const transport = entry.transport!;
    const id = invocation?.attemptId ?? randomUUID();
    return this.#track(entry, async () => {
      const envelope: InvocationEnvelope = {
        id, node, ...(invocation && { operationId: invocation.operationId }), target: entry.address, payload: await this.#codec.encode(input),
        ...(site.source && { source: site.source }), ...(execution && { execution }),
      };
      const response = await transport.invoke(envelope, options);
      options.signal?.throwIfAborted();
      if (response.invocationId !== id) throw new TransportError("INVALID_RESPONSE", "outcome_unknown", envelope,
        "Transport returned a mismatched invocation ID");
      return this.#codec.decode(response.payload);
    });
  }

  #context(entry: WorkerEntry, execution?: ExecutionScope, signal?: AbortSignal, invocation?: WorkerContext["invocation"]): WorkerContext {
    return {
      resources: undefined, config: undefined, artifacts: this.#codec.artifacts,
      services: entry.services ?? this.services, worker: entry.address, execution,
      ...(invocation && { invocation: { operationId: invocation.operationId, attemptId: invocation.attemptId } }),
      ...(signal ? { signal } : {}),
      run: (plan, input) => {
        // Validate all capabilities before allowing any internal side effects.
        for (const task of plan.tasks) {
          if (!entry.nodeTypes!.includes(task.node)) throw new Error(`Worker does not implement ${task.node}`);
        }
        const options = { ...(signal && { signal }), ...(execution?.executionId && { executionId: execution.executionId }) };
        return runGraph(plan, input, (node, value, scope, onAcceptedAttempt) =>
          this.#invoke(node, value, options, { task: scope, owner: entry, ...(onAcceptedAttempt && { onAcceptedAttempt }) }), options, this.reportExecution);
      },
      invoke: <N extends NodeType>(node: N, input: InputOf<NoInfer<N>>, options: InvokeOptions = {}) =>
        this.#invoke(node, input, {
          ...options,
          ...(signal ? { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal } : {}),
        }, { source: entry.address, ...(execution && { parent: execution }) }) as Promise<OutputOf<N>>,
      emit: <T>(event: RuntimeEvent<T>) => this.#events.emit(event),
    };
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing) throw new Error("Runtime is closed");
  }

  #operation<T>(execute: () => Promise<T>): Promise<T> {
    const job = (async () => execute())();
    this.#jobs.add(job);
    return job.finally(() => { this.#jobs.delete(job); });
  }

  #checkId(id: string): void {
    this.#assertOpen();
    if (!id || this.#workers.has(id)) throw new Error(`Duplicate or empty Worker ID: ${id}`);
  }

  #capabilities(address: WorkerAddress, nodes: readonly NodeType[]): readonly NodeType[] {
    if (!address.workerType.trim() || !nodes.length || nodes.some((node) => !/^[^.]+\..+$/.test(node))) {
      throw new Error(`Invalid capabilities for Worker ${address.workerId}`);
    }
    return Object.freeze([...new Set(nodes)]);
  }

  #add(entry: WorkerEntry): WorkerHandle {
    this.#workers.set(entry.address.workerId, entry);
    const unavailable = () => this.reportExecution?.({ type: "worker.unavailable", workerId: entry.address.workerId });
    const unsubscribe = this.reportExecution && entry.transport?.onUnavailable?.(unavailable);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      unsubscribe?.();
      entry.available = false;
      if (this.#workers.get(entry.address.workerId) === entry) this.#workers.delete(entry.address.workerId);
      await Promise.allSettled(entry.pending);
      try { await entry.executor?.dispose?.(); }
      finally { this.#closers.delete(close); }
    })();
    this.#closers.add(close);
    return Object.freeze({
      address: entry.address,
      setAvailable: (available: boolean) => {
        if (closing) return;
        const wasAvailable = isWorkerAvailable(entry);
        entry.available = available;
        if (wasAvailable && !available) unavailable();
      },
      close,
      unregister: () => {
        if (this.#workers.get(entry.address.workerId) !== entry) return false;
        unsubscribe?.();
        return this.#workers.delete(entry.address.workerId);
      },
    });
  }

  #track<T>(entry: WorkerEntry, execute: () => Promise<T>): Promise<T> {
    if (entry.active >= entry.concurrency) return Promise.reject(new Error("Worker capacity exceeded"));
    entry.active++;
    const job = Promise.resolve().then(execute);
    entry.pending.add(job);
    return job.finally(() => { entry.active--; entry.pending.delete(job); });
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      // Stop event intake; queued handlers and accepted graphs keep their Workers alive.
      for (const unsubscribe of this.#subscriptions) unsubscribe();
      await Promise.resolve();
      while (this.#jobs.size) await Promise.allSettled([...this.#jobs]);
      this.#closed = true;
      const results = await Promise.allSettled([...this.#closers].map(close => close()));
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Worker cleanup failed");
    })();
  }
}

export function createDitto(options: DittoOptions = {}): DittoRuntime {
  return new DittoRuntime(options);
}
