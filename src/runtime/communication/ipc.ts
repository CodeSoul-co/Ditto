import type { DittoRuntime } from "../runtime.js";
import { TransportError, type TransportErrorCode, type InvocationEnvelope, type InvocationResult, type InvokeTransport } from "./transport.js";

/** Node child_process ChildProcess or process; the application owns process lifetime. */
export interface IpcChannel extends Pick<NodeJS.EventEmitter, "on" | "off"> {
  readonly connected?: boolean | undefined;
  readonly exitCode?: string | number | null | undefined;
  readonly signalCode?: NodeJS.Signals | null;
  send?(message: object, callback?: (error: Error | null) => void): boolean;
}
export interface IpcTransportOptions {
  readonly id: string;
  readonly channel: IpcChannel;
  readonly timeoutMs?: number;
}
export interface IpcTransport extends InvokeTransport {
  /** Detach listeners and reject outstanding callers; does not kill the child. */
  close(): void;
}
const protocol = "ditto:invoke:1";
interface Packet {
  protocol: typeof protocol;
  kind: "request" | "response";
  id: string;
  envelope?: InvocationEnvelope;
  result?: InvocationResult;
  error?: string;
}
function packet(value: unknown): value is Packet {
  return !!value && typeof value === "object" && "protocol" in value && value.protocol === protocol
    && "id" in value && typeof value.id === "string" && value.id !== ""
    && "kind" in value && (value.kind === "request" || value.kind === "response");
}
function send(channel: IpcChannel, value: Packet): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!channel.send) { reject(new Error("IPC channel is not connected")); return; }
    // false means queued, not failed; the callback reports delivery to the channel.
    channel.send(value, error => { if (error) reject(error); else resolve(); });
  });
}

/** Same-machine process transport using Node's inherited IPC channel, no TCP socket. */
export function createIpcTransport({ id, channel, timeoutMs = 30_000 }: IpcTransportOptions): IpcTransport {
  if (!id || !channel.send) throw new Error("IPC requires an ID and a connected channel");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("IPC timeoutMs must be between 1 and 2147483647");
  }
  const pending = new Map<string, { resolve(value: InvocationResult): void; fail(code: TransportErrorCode, message: string): void }>();
  let closed = false;
  let exited = false;
  // ChildProcess records the exit status even when disconnect arrived first.
  const closeCode = () => exited || ("signalCode" in channel && (channel.signalCode != null || channel.exitCode != null))
    ? "WORKER_EXITED" : "CHANNEL_CLOSED";
  const onMessage = (value: unknown): void => {
    if (!packet(value) || value.kind !== "response") return;
    const job = pending.get(value.id);
    if (!job) return;
    if (value.error) job.fail("REMOTE_ERROR", value.error);
    else if (value.result?.invocationId === value.id && value.result.payload) job.resolve(value.result);
    else job.fail("INVALID_RESPONSE", "Invalid IPC result");
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    channel.off("message", onMessage);
    channel.off("disconnect", close);
    channel.off("exit", onExit);
    for (const job of pending.values()) job.fail(closeCode(), "IPC transport is closed");
  };
  const onExit = (): void => { exited = true; close(); };
  channel.on("message", onMessage);
  channel.on("disconnect", close);
  channel.on("exit", onExit);
  if (channel.connected === false) close();
  return {
    id, close,
    get available() { return !closed && channel.connected !== false; },
    invoke(envelope, options) {
      if (closed || channel.connected === false)
        return Promise.reject(new TransportError(closeCode(), "not_sent", envelope, "IPC transport is closed"));
      if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
      if (pending.has(envelope.id))
        return Promise.reject(new TransportError("INVALID_REQUEST", "not_sent", envelope, "Duplicate IPC invocation ID"));
      return new Promise<InvocationResult>((resolve, reject) => {
        const finish = (error: unknown, result?: InvocationResult): void => {
          if (pending.get(envelope.id) !== job) return;
          pending.delete(envelope.id);
          clearTimeout(timer);
          options?.signal?.removeEventListener("abort", abort);
          if (result) resolve(result); else reject(error);
        };
        const abort = (): void => finish(options?.signal?.reason);
        const job = {
          resolve: (result: InvocationResult) => finish(undefined, result),
          fail: (code: TransportErrorCode, message: string, cause?: unknown) =>
            finish(new TransportError(code, "outcome_unknown", envelope, message, { cause })),
        };
        const timer = setTimeout(() => job.fail("TIMEOUT", "IPC invocation timed out"), timeoutMs);
        pending.set(envelope.id, job);
        options?.signal?.addEventListener("abort", abort, { once: true });
        void send(channel, { protocol, kind: "request", id: envelope.id, envelope })
          .catch(error => job.fail("COMMUNICATION_ERROR", "IPC send failed", error));
      });
    },
  };
}

/** Attach to a trusted parent/child channel. Never accepts deployment or sandbox overrides. */
export function serveWorkerIpc(runtime: DittoRuntime, channel: IpcChannel): { close(): Promise<void> } {
  if (!channel.send) throw new Error("IPC channel is not connected");
  const pending = new Set<Promise<void>>();
  const onMessage = (value: unknown): void => {
    if (!packet(value) || value.kind !== "request") return;
    const job = (async () => {
      let response: Packet;
      try {
        if (!value.envelope || value.envelope.id !== value.id) throw new Error("Invalid IPC invocation");
        response = { protocol, kind: "response", id: value.id, result: await runtime.receive(value.envelope) };
      } catch { response = { protocol, kind: "response", id: value.id, error: "Worker invocation failed" }; }
      // A disconnected caller cannot receive the result; local execution is already settled.
      await send(channel, response).catch(() => {});
    })();
    pending.add(job);
    void job.finally(() => { pending.delete(job); });
  };
  channel.on("message", onMessage);
  return { async close() { channel.off("message", onMessage); await Promise.all([...pending]); } };
}
