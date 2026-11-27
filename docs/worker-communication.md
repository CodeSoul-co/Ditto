# Worker Communication and Deployment

**English** · [简体中文](worker-communication.zh-CN.md)

> Runtime `invoke` / `emit` are internal communication semantics, not Interaction Nodes. Application Graphs and Loops invoke exposed leaf capabilities; the Loop and its state remain with the caller.

## Location and Invocation

| Location | Current implementation | Data and execution |
| --- | --- | --- |
| Same process | Direct Worker executor calls | Preserves object identity without serialization |
| Different processes on one host | Native Node IPC; HTTP loopback is also available | Serializes public Node calls; preferred over cross-host routing |
| Different servers | HTTP(S) transport and receiving handler | Authentication, Envelope validation, response correlation, size limits, and timeouts |

`ctx.invoke` and top-level `runtime.invoke` share capability routing. The HTTP adapter uses the standard library and does not depend on frameworks such as Express. worker_threads / MessagePort / NATS require a custom `InvokeTransport`. HTTP is a working network adapter, tested through real loopback sockets.

## Same-host IPC

Use `createIpcTransport({ id, channel: child, timeoutMs })` with a ChildProcess returned by `node:child_process.fork`; register Workers in the child and call `serveWorkerIpc(runtime, process)`. Exchange the exact Worker address, use the same hostId with distinct processId values, and bind the transport through registerRemote. Routing prefers same process, same host, then other hosts; explicit workerId bindings remain strict.

IPC reuses the inherited channel without a TCP port or network token. Calls still pass through envelopes, target identity checks, public capabilities and capacity limits; business payloads must remain serializable. Timeout, cancellation and disconnect stop the caller's wait without rolling back or forcibly terminating remote work. Applications own process/transport lifetime; call ipc.close() during shutdown. Receiver.close() detaches intake and drains accepted replies.

See [placement.ts](worker-api/examples/runtime/placement.ts) for both modes and [Runtime API](worker-api/runtime.md) for detailed interfaces.

## HTTP Example

The following snippets are startup code for two separate processes. Exchange registered addresses through deployment configuration. Public Node implementations and internal Graphs must already be deployed on the execution host.

Server:

```ts
import { createServer } from "node:http";
import { createDitto, createContextWorker, loadRuntimeConfigFile, createWorkerHttpHandler } from "@codesoul-co/ditto";

const token = process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_TRANSPORT_HTTP_WORKER_TOKEN");
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ hostId: "server-a", processId: "agent-service", config });
const worker = runtime.register(createContextWorker({ policy: config.context.policy ?? {}, concurrency: 8 }), "context-a");
const server = createServer(createWorkerHttpHandler(runtime, { token }));
server.listen(8080, "127.0.0.1");
console.log(worker.address); // Pass to the caller through deployment configuration; contains no key
```

Caller:

```ts
import { createDitto, createHttpTransport } from "@codesoul-co/ditto";

const token = process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_TRANSPORT_HTTP_WORKER_TOKEN");
const transport = createHttpTransport({
  id: "server-a-http", url: "http://127.0.0.1:8080/ditto/invoke", token, timeoutMs: 30_000,
});
const runtime = createDitto({ hostId: "client", transports: [transport] });
runtime.registerRemote({
  address: { workerId: "context-a", workerType: "CONTEXT", hostId: "server-a", processId: "agent-service" },
  capabilities: ["CONTEXT.LOAD"], transportId: transport.id,
});
try {
  console.log(await runtime.invoke("CONTEXT.LOAD", { sources: [{ role: "user", content: "hello" }] }));
} finally { await runtime.close(); }
```

For cross-server deployments, use a controlled HTTPS endpoint with TLS termination or a Node HTTPS Server. The plaintext loopback example is for local development. Install one transport per server and register each server's addresses. Workers exposing the same capability participate in routing without changing Graphs.

The same registration works with `runtime.run()` and `runtime.loop()`. A Loop may select a different DAG each round; only that DAG's Node calls cross HTTP. Deploy and expose every capability the selected Graphs need. Each execution host owns its resources, Provider configuration, and permissions. Remote registration does not upload Graph functions or Loop state machines.

## Protocol and Responsibilities

Requests contain an invocation ID, source/target Worker addresses, Node name, payload, and optional Graph/run/task identifiers. Response IDs must match. HTTP uses `x-ditto-protocol: 1`, a Bearer token, and a default body limit of 1 MiB. Redirects are rejected to avoid forwarding authentication headers elsewhere.

The receiving handler validates the Envelope shape. The Runtime then checks target host/process/type/id, public capability, and availability. Nodes and tool executors remain responsible for business-input validation; TypeScript declarations do not validate network inputs at runtime. HTTP errors do not expose handler stacks or Provider response bodies.

The token is a service-level credential that authorizes all public capabilities in that service's Runtime; it is not a tenant or per-Node ACL. External requests should pass through the application's authentication/tenant gateway. Use `expose` to limit public entry points. The execution host owns Provider keys, connections and Sandbox settings; envelopes cannot override those settings. INFER business input still explicitly selects a model resolved through configured Providers. Business inputs may still contain sensitive content, so applications must manage logging and storage accordingly.

By default each call has one attempt. A timeout or disconnect can leave the remote result unknown. HTTP cancellation ends the caller’s wait and a remote service can still finish the operation.

### Execution events and optional failover

Pass `onExecutionEvent` and/or `recoveryPolicy` to `createDitto` or `createAgent`. Both options are supplied by the host. A minimal two-attempt configuration is:

```ts
const runtime = createDitto({
  onExecutionEvent(event) { console.log(event); },
  recoveryPolicy: { maxAttempts: 2 },
});
```

- **Tracking.** One logical operation emits `operation.dispatched`. Each physical dispatch has its own `attempt.started`, followed by `attempt.succeeded` or `attempt.failed`. Attempts share an `operationId` and have distinct `attemptId` values matching the wire invocation IDs. Worker handlers receive both through `ctx.invocation`. A successful inference attempt includes usage when its provider reports it. A lost response has unknown usage.
- **Commit and persistence.** `operation.committed` names the accepted attempt. In a Graph it follows output validation. `checkpoint.saved` follows the host’s successful save and includes the checkpoint digest. Graph events identify the run and leaf; Graph checkpoint events list confirmed and uncertain leaf IDs. A checkpointed Graph keeps its run identity on resume; each configured Loop iteration has a distinct Graph run. Restoring confirmed outputs emits no new attempt. `checkpoint.restored` reports the loaded snapshot. To observe offline reconciliation, pass the same observer as the third argument to `reconcileGraphCheckpoint`. Its `checkpoint.reconciled` event reports the decision; the host still owns the save.
- **Worker state.** `worker.unavailable` reports an observed IPC disconnect or a registration marked unavailable. HTTP timeouts describe an attempt and do not establish that the whole Worker is down. Observers run at the dispatcher, without waiting for async exporters. An observer failure does not affect execution.
- **Failover.** The budget includes the initial dispatch. An unpinned call can move to another registered compatible Worker with capacity; each Worker ID is tried once. The default policy permits only `not_sent` channel, worker-exit, communication and timeout failures. Invalid requests, protocol errors, remote application errors and pinned calls propagate. Cancellation stops further attempts. `recovery.decided` records the choice and, on retry, the next Worker.
- **Unknown outcomes.** Supply `shouldRetry({ operationId, node, input, error, signal })` for application decisions. It may await a receipt and must return true only when replay is safe. Side-effecting operations need a shared idempotency key or equivalent coordination across replicas. The budget applies to this live invocation. Pending checkpoint intents still require explicit reconciliation after a restart.

During shutdown, first stop accepting new HTTP requests and await application-level work, then close the Runtime and Server. Owners close external MCP and Provider connections. `registerRemote` only adds a local directory entry; it does not start a server or copy Worker code to another machine.

## invoke, emit, and Artifacts

`invoke` is request/response; `emit` submits an event to EventFabric. The default LocalEventFabric performs asynchronous in-process fan-out. A successful emit means only that the event was accepted. `drainEvents()` returns consumer failures. Runtime.close does not automatically close a shared EventFabric. Cross-server Pub/Sub requires an external EventFabric independent of the request transport; HTTP invoke does not forward events implicitly.

Transport payloads use either `inline` or `reference`. With an ArtifactStore, JSON data exceeding inlineLimitBytes (64 KiB by default) can be stored and passed by reference; responses use the same mechanism. Direct in-process calls do not scan payload sizes.

InMemoryArtifactStore is for single-process experiments. Cross-host references require a Store/Resolver accessible to both hosts; its implementation owns access control, TTL, and cleanup. Automatically generated references are not collected automatically. Without a shared Store, keep data inline and choose appropriate body limits. The network boundary supports JSON-encodable inputs and outputs, not arbitrary classes, functions, undefined, or binary streams.

See [composition APIs](worker-api/composition.md) for each ArtifactStore, PayloadCodec and EventFabric method with examples.
