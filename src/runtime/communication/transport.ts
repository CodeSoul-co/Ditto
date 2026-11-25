import type { NodeType } from "../../contracts/index.js";
import type { WorkerType } from "../../worker/node.js";
import type { Payload } from "../artifact.js";

export interface WorkerAddress {
  readonly workerId: string;
  readonly workerType: WorkerType;
  readonly hostId: string;
  readonly processId: string;
}

export interface ExecutionScope {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
}

export interface InvokeOptions {
  readonly workerId?: string;
  readonly signal?: AbortSignal;
}

export interface InvocationEnvelope {
  readonly id: string;
  readonly source?: WorkerAddress;
  readonly target: WorkerAddress;
  readonly node: NodeType;
  readonly payload: Payload;
  readonly execution?: ExecutionScope;
}

export interface InvocationResult {
  readonly invocationId: string;
  readonly payload: Payload;
}

export type TransportErrorCode = "CHANNEL_CLOSED" | "WORKER_EXITED" | "TIMEOUT" | "COMMUNICATION_ERROR"
  | "INVALID_REQUEST" | "REMOTE_ERROR" | "INVALID_RESPONSE";
/** Whether this attempt could have produced external effects. */
export type InvocationStatus = "not_sent" | "outcome_unknown";

export class TransportError extends Error {
  readonly invocationId: string;
  readonly workerId: string;
  constructor(readonly code: TransportErrorCode, readonly status: InvocationStatus,
    envelope: InvocationEnvelope, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransportError";
    this.invocationId = envelope.id;
    this.workerId = envelope.target.workerId;
  }
}

/** Adapter owns IPC/RPC encoding, network errors and authentication. */
export interface InvokeTransport {
  readonly id: string;
  /** A known unavailable route is excluded from new calls to all Workers on it. */
  readonly available?: boolean;
  invoke(envelope: InvocationEnvelope, options?: { signal?: AbortSignal }): Promise<InvocationResult>;
}

export interface RemoteWorker {
  readonly address: WorkerAddress;
  readonly capabilities: readonly NodeType[];
  readonly transportId: string;
  /** Caller-side concurrency limit; the receiver enforces its own limit too. */
  readonly concurrency?: number;
}
