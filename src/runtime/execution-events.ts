import type { NodeType } from "../contracts/index.js";
import type { Usage } from "../worker/infer/types.js";
import type { ExecutionScope, InvocationStatus, TransportError, TransportErrorCode } from "./communication/transport.js";

export interface ExecutionOperation {
  readonly operationId: string;
  readonly node: NodeType;
  readonly execution?: ExecutionScope;
}
export interface ExecutionAttempt extends ExecutionOperation {
  readonly attemptId: string;
  readonly workerId: string;
  readonly attempt: number;
}
export interface RecoveryPolicy {
  /** Total physical attempts, including the first. Each Worker ID is tried at most once. */
  readonly maxAttempts: number;
  /** Return true only if replay is safe. Without a callback only unsent transport failures qualify. */
  readonly shouldRetry?: (failure: ExecutionAttempt & {
    readonly error: TransportError; readonly input: unknown; readonly signal?: AbortSignal;
  }) => boolean | Promise<boolean>;
}

type ExecutionRecord =
  | (ExecutionOperation & { type: "operation.dispatched" })
  | (ExecutionAttempt & { type: "operation.committed" })
  | (ExecutionAttempt & { type: "attempt.started" })
  | (ExecutionAttempt & { type: "attempt.succeeded"; usage?: Usage })
  | (ExecutionAttempt & { type: "attempt.failed"; code?: TransportErrorCode; status?: InvocationStatus })
  | (ExecutionAttempt & { type: "recovery.decided"; decision: "retry" | "stop"; nextWorkerId?: string })
  | { type: "worker.unavailable"; workerId: string }
  | { type: "checkpoint.reconciled"; scope: string; digest: string; runId?: string; executionId?: string; confirmed: readonly string[]; retry: readonly string[] }
  | { type: "checkpoint.saved" | "checkpoint.restored"; scope: string; digest: string; runId: string; executionId: string;
      confirmed?: readonly string[]; uncertain?: readonly string[] };

export type ExecutionEvent = ExecutionRecord & { readonly timestamp: number };
export type ExecutionObserver = (event: ExecutionEvent) => void | Promise<void>;
export type ExecutionReporter = (record: ExecutionRecord) => void;

export function executionReporter(observer: ExecutionObserver): ExecutionReporter {
  return record => {
    // Telemetry must never turn a completed external effect into a failed attempt.
    try {
      const scope = "execution" in record && record.execution;
      const pending = observer({ ...record, ...(scope && { execution: { ...scope } }), timestamp: Date.now() });
      if (pending) void Promise.resolve(pending).catch(() => {});
    } catch { /* The observer owns its diagnostics. */ }
  };
}

export function graphOperation(scope: ExecutionScope, node: NodeType): ExecutionOperation {
  return { operationId: JSON.stringify([scope.runId, scope.graphId, scope.nodeId]), node, execution: scope };
}
