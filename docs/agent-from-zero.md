# Run a complete Agent from scratch, then deploy remote Workers

[简体中文](agent-from-zero.zh-CN.md) · [Configuration reference](agent-json.md)

This walkthrough uses published `@codesoul-co/ditto@0.1.4` and `@codesoul-co/ditto-retrieval@0.1.0`. First run a JSON-defined Agent with five Workers in one process, then move its Node calls to HTTP without changing its Graph or Loop. A real model, tool, Redis and file SQLite participate in execution. The example business code belongs to your application, not to hidden Core exports.

## 1. Create an independent npm project

Prepare Node.js 24+, npm 11+, a model service supporting native tool calls, and a reachable Redis service. The archive contains application examples; `npm install` installs published packages without building Ditto source.

```sh
mkdir my-ditto-agent
cd my-ditto-agent
curl -fL https://codesoul-co.github.io/Ditto/downloads/ditto-examples.zip -o examples.zip
unzip -q examples.zip
npm install
cp examples/package-basics/.env.example .env
cp examples/json-agent/npm-scenarios/single/ditto.example.yaml ditto.yaml
cp examples/json-agent/npm-scenarios/single/agent.json agent.json
cp examples/json-agent/npm-scenarios/single/input.example.json input.json
mkdir -p task
cp examples/json-agent/npm-scenarios/single/guide.example.json task/guide.json
```

The important files are:

```text
agent.json                      Graph / Node / Loop / Worker bindings
ditto.yaml                      Runtime defaults, Context policy and cache settings
.env                            Model credentials, network permission, Redis URL
input.json                      One business request, without credentials
task/guide.json                  Retrieval knowledge source
examples/json-agent/npm-scenarios/
  cli.mjs                       Reads JSON and calls the local host
  host.ts                       Creates resources and Workers; runs/closes the Agent
  remote.mjs                    HTTP Worker server and controller
examples/_shared/tools/storage/ Application Redis and SQLite adapters
```

## 2. Configure the model and Redis

Replace the placeholders in `.env`:

```dotenv
DITTO_SHARED_PROVIDERS=primary
DITTO_SHARED_PROVIDER_PRIMARY_KIND=openai-compatible
DITTO_SHARED_PROVIDER_PRIMARY_BASE_URL=https://your-provider.example/v1
DITTO_SHARED_PROVIDER_PRIMARY_API_KEY=YOUR_API_KEY
DITTO_SHARED_PROVIDER_PRIMARY_MODEL=YOUR_TOOL_CAPABLE_MODEL
DITTO_WORKER_INFER_MODEL_PROVIDER=primary
DITTO_WORKER_INFER_MODEL=YOUR_TOOL_CAPABLE_MODEL
DITTO_SHARED_SANDBOX_ALLOW_NETWORK=https://your-provider.example
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
```

`BASE_URL` is the API root; the network permission is its origin without `/v1`. The model must return native tool calls, not just text. See [model providers](worker-api/providers.md) for other provider kinds.

Use an existing Redis service, or run this in another terminal on a machine with Redis installed:

```sh
redis-server --bind 127.0.0.1 --port 6379
```

Memory uses Node's built-in `node:sqlite` and creates `task/memory.sqlite`; no SQL server is required. To use PostgreSQL/MySQL, supply an application adapter implementing `MemoryStore` and a connection pool. A YAML field alone cannot switch the backend.

Runtime services automatically read `ditto.yaml`; the launch command loads `.env` through `--env-file`. `host.ts` shares that startup configuration across Workers and passes Context cache settings to the Redis adapter. Configuration loading does not open database connections.

## 3. Wire resources for all five Workers

`openScenarioResources()` in [host.ts](../examples/json-agent/npm-scenarios/host.ts) provides:

| Worker | Actual resource | Injection point |
| --- | --- | --- |
| Context | Connected Redis client, scoped cache and TTL | `createContextWorker({ redis: { client, ...cache } })` |
| Memory | Persistent SQLite `MemoryStore` | `createMemoryWorker({ store })` |
| Infer | HTTP Provider built from environment configuration, wrapped to count calls | `createInferWorker({ providers })` |
| Interaction | `count_characters` implementation and answer-file OutputSink | `createInteractionWorker({ tools, output })` |
| Retrieval | Keyword Provider reading `task/guide.json` | `createRetrievalWorker({ providers: registry })` |

Retrieval here is file keyword search, not a vector database. Replace its Provider to use a vector service. Add MCP, web-search or command tools at the same host integration boundary. Storage implementations are in [workers.ts](../examples/_shared/tools/storage/workers.ts), [redis-context.ts](../examples/_shared/tools/storage/redis-context.ts) and [sqlite-memory.ts](../examples/_shared/tools/storage/sqlite-memory.ts). These are copyable application adapters, not npm exports.

Tools have two distinct representations: `agent.json.config.actions` describes tools to the model; `validate` / `execute` in the host's `tools` array implement them. Names and input contracts must match. The host provides a `count-only` service profile allowing only `count_characters`; JSON selects that authorized profile through `deployment.workers[].services`, without granting its own permissions. The host's OutputSink chooses the answer directory.

## 4. Load JSON, run and inspect the output

[agent.json](../examples/json-agent/npm-scenarios/single/agent.json) defines a 13-node main Graph and its outer Loop:

```text
Memory read + Retrieval search
  → Context load / select
  → Infer produces a tool request
  → Interaction executes / observes
  → Context updates / selects
  → Infer produces the answer
  → Memory saves / reads back
  → Interaction writes the answer file
```

Run:

```sh
node --env-file=.env examples/json-agent/npm-scenarios/cli.mjs agent.json input.json task
cat task/answers/demo-1.md
```

Expect `3`, the Unicode code-point count of `A😀B`. Terminal output contains `answer`, `characters`, the audit token and an execution trace. SQLite stores the result; Redis stores the turn's Context. Give each new task a fresh `memoryKey`, `deliveryId` and scope. This single-Graph example does not automatically deduplicate repeated tasks.

The CLI follows `readFile → JSON.parse → runScenario → createAgent → agent.run → agent.close`. Only `agent.json` defines Graph/Loop orchestration; the host does not rewrite dependencies in code. `deployment.workers[].use` selects a host registry entry, `id` names its instance, and `bindings` maps nodes to that ID.

This five-Worker path needs no third-party extension. [routed/agent.json](../examples/json-agent/npm-scenarios/routed/agent.json) adds main routing, Subgraphs and a recovery branch; it also needs the example `text` Worker. Build/install that local extension as described in the [npm scenarios](../examples/json-agent/npm-scenarios/README.md); its package is not published to npm.

## 5. Integrate with a long-running application

The CLI opens and closes resources once per invocation. A server should open resources and create an Agent at startup, then reuse it for requests:

```js
import { readFile } from "node:fs/promises";
import { createAgent } from "@codesoul-co/ditto/runtime";
import { openScenarioResources, validateScenarioRequest } from "./examples/json-agent/npm-scenarios/host.ts";

const definition = JSON.parse(await readFile("agent.json", "utf8"));
const resources = await openScenarioResources("task");
try {
  const agent = await createAgent(definition, {
    config: resources.config,
    workers: resources.workers,
    serviceProfiles: resources.serviceProfiles,
  });
  try {
    const request = JSON.parse(await readFile("input.json", "utf8"));
    validateScenarioRequest(request);
    // Repeat in your request handler; trusted application code determines identity/scope.
    console.log(await agent.run({ ...request, model: resources.model }));
  } finally { await agent.close(); } // On shutdown: stop accepting requests, then drain.
} finally { await resources.close(); } // Close injected Redis / SQLite last.
```

Workers and connections are reused, while request inputs, Loop state and results remain independent. Concurrent writes to one session need application serialization/CAS, beyond Graph concurrency. Replace the example's trace arrays with bounded logs/metrics in a long-running service.

## 6. Move the same JSON to HTTP Workers

The published package already provides `createHttpTransport()`, `createWorkerHttpHandler()` and `registerRemote()`. Keep `agent.json` unchanged, initially placing all five Workers on one server and leaving Graph/Loop orchestration on the controller.

```text
Controller: agent.json → compileAgent → Runtime + registerRemote
                                      ↓ HTTP(S) Node calls
Worker server: HTTP handler → local Workers → model / Redis / SQLite / tools
```

First validate two processes on one machine. Generate a shared token and put it in both the server's `.env` and a separate `controller.env`:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

```dotenv
DITTO_TRANSPORT_HTTP_WORKER_TOKEN=PASTE_THE_SAME_GENERATED_TOKEN
```

The server retains model and Redis settings; the controller's environment needs only the transport token. Do not put credentials in `agent.json` or the deployment manifest.

Terminal A starts the Worker service and writes its address manifest:

```sh
node --env-file=.env examples/json-agent/npm-scenarios/remote.mjs serve task deployment.json
```

Terminal B runs the original Agent configuration. Use new task IDs or a fresh server task directory to avoid reusing the previous write's keys:

```sh
node --env-file=controller.env examples/json-agent/npm-scenarios/remote.mjs run agent.json input.json deployment.json
```

`deployment.json` is this application's connection manifest, containing a URL, non-secret model identifiers, Worker addresses and capabilities. It is not a new Ditto configuration schema. The controller loads it, creates a transport, calls `runtime.registerRemote()`, then executes `compileAgent(definition).run(runtime, input)`. It creates no local Workers and needs no model keys or database clients.

The server uses the same resource factory and fixed Worker IDs, with Interaction restricted to `count-only`. The remote path does not execute JSON's local Worker factories or send `serviceProfiles` to the server as authorization. Change server host configuration to change execution permissions.

For separate machines, set server `DITTO_EXAMPLE_WORKER_BIND` (default `127.0.0.1`), `DITTO_EXAMPLE_WORKER_PORT` (default `8080`) and `DITTO_EXAMPLE_WORKER_URL=https://worker.example/ditto/invoke`. Configure a controlled TLS endpoint and copy the generated manifest to the controller through your trusted deployment channel. Restarts change processId, so republish the manifest. A loopback URL does not become reachable from another machine automatically.

Answer files and SQLite stay in the server's `task` directory; the controller receives JSON results. SQLite is not a shared multi-host database. When splitting Workers among several services, initialize only each service's required resources, create a transport per service, and register its actual Worker addresses. Keep Worker IDs stable to retain JSON bindings. Core does not provide automatic discovery, code distribution or remote process startup.

## 7. Communication boundaries and validation

| Placement | Current transport | Application responsibilities |
| --- | --- | --- |
| Same process | Direct registered Worker calls | Resource creation and cleanup |
| Separate local processes | `createIpcTransport` + `serveWorkerIpc`, or HTTP | Start the process, register addresses, close IPC; see [placement.ts](worker-api/examples/runtime/placement.ts) |
| Separate machines | HTTP(S) transport + Worker handler | Deploy services, token/TLS, address manifests and connectivity |

Graph/Loop state stays on the controller; Node inputs/outputs cross the transport. An HTTP token authorizes the server's exposed capabilities, not tenant ACLs; the application entry still needs controller authentication. Network timeouts do not guarantee remote cancellation, and there is no automatic retry or exactly-once execution. Define idempotency keys for writes. See [Worker communication](worker-communication.md) for cross-host events and large payload storage.

Repository development verification (these scripts are not in the consumer archive):

```sh
node --env-file=.env scripts/check-json-agent-package.ts --registry --keep
```

This installs public npm packages outside the repository and verifies local five-Worker tool execution, the CLI without an extension, unchanged JSON over real HTTP including incorrect tokens, third-party Workers, Subgraph routing, cross-process recovery from SQLite after Redis expiry, budgets, permissions and storage failures. HTTP verification uses two local processes and a real socket; it does not verify your production TLS, cross-machine network or PostgreSQL/MySQL deployment.


After loading the configuration, see [execution and recovery](agent-execution.md) for standalone Graphs, durable resume, message boundaries and canvas editor tooling.
