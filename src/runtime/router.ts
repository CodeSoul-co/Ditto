import type { NodeType } from "../contracts/index.js";
import type { WorkerExecutor } from "../worker/define-worker.js";
import type { RuntimeServices } from "./services.js";
import type { InvokeTransport, WorkerAddress } from "./communication/transport.js";

export interface WorkerEntry {
  readonly address: WorkerAddress;
  readonly capabilities: readonly NodeType[];
  readonly nodeTypes?: readonly NodeType[];
  readonly executor?: WorkerExecutor;
  readonly services?: RuntimeServices;
  readonly transport?: InvokeTransport;
  available: boolean;
  readonly concurrency: number;
  active: number;
  readonly pending: Set<Promise<unknown>>;
}

export function isWorkerAvailable(entry: WorkerEntry): boolean {
  return entry.available && entry.transport?.available !== false;
}

export class NoWorkerAvailableError extends Error {
  constructor(readonly node: NodeType) {
    super(`No available Worker implements ${node}`);
    this.name = "NoWorkerAvailableError";
  }
}

/** Filters actual capability/availability, then direct > same host > remote. */
export class WorkerRouter {
  readonly #next = new Map<NodeType, number>();

  select(node: NodeType, entries: Iterable<WorkerEntry>, hostId: string, workerId?: string, excluded?: ReadonlySet<string>): WorkerEntry | undefined {
    let priority = Infinity;
    const pool: WorkerEntry[] = [];
    for (const entry of entries) {
      if (workerId !== undefined && entry.address.workerId !== workerId) continue;
      if (excluded?.has(entry.address.workerId)) continue;
      if (!isWorkerAvailable(entry) || entry.active >= entry.concurrency || !entry.capabilities.includes(node)) continue;
      const rank = entry.executor ? 0 : entry.address.hostId === hostId ? 1 : 2;
      if (rank < priority) { priority = rank; pool.length = 0; }
      if (rank === priority) pool.push(entry);
    }
    if (!pool.length) return undefined;
    const index = (this.#next.get(node) ?? 0) % pool.length;
    this.#next.set(node, (index + 1) % pool.length);
    return pool[index]!;
  }
}
