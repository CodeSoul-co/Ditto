# Build an Agent with agent.json

**English** · [简体中文](agent-json.zh-CN.md)

Start with one `agent.json`: define a required `main` Graph, optional reusable Subgraphs, optional Loop control, non-secret parameters and deployment references. The host supplies real Worker definitions, tools, credentials and authorized services. `createAgent()` compiles the configuration, registers the selected Workers and exposes `run()` / `close()` through the npm package.

The hierarchy stays **Loop → Graph/Subgraph → Node → Worker**. A Subgraph groups a DAG; it never owns a Loop. Conditions, repetition and stopping belong to the outer Loop. Without `loop`, `main` executes once.

## 1. Install and run

Use Node.js 24+, npm 11+, ESM and `@codesoul-co/ditto@0.1.3` or later:

```sh
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto
```

Start with the standard root template [agent_example.json](../agent_example.json). It includes main, a Subgraph, a Loop and Worker registration/bindings; edit ordinary parameters in `config`. After npm installation, copy it:

```sh
cp node_modules/@codesoul-co/ditto/agent_example.json agent.json
```

In the source repository, use `cp agent_example.json agent.json`. The smaller single-Graph, multi-node version below (LOAD → SELECT) can also be saved as `agent.json`. Both configurations use the host code below.

```json
{
  "version": 1,
  "id": "hello",
  "graphs": {
    "main": {
      "nodes": [
        {
          "id": "loaded",
          "type": "CONTEXT.LOAD",
          "input": {
            "sources": [{ "role": "user", "content": { "$ref": "input" } }]
          }
        },
        {
          "id": "selected",
          "type": "CONTEXT.SELECT",
          "dependsOn": ["loaded"],
          "input": {
            "context": { "$ref": "nodes.loaded" },
            "purpose": "infer",
            "limit": 1
          }
        }
      ],
      "output": { "$ref": "nodes.selected.context.items.0.content" }
    }
  },
  "deployment": {
    "workers": [{ "id": "context", "use": "context" }],
    "bindings": { "main": { "loaded": "context", "selected": "context" } }
  }
}
```

Save as `app.mjs` and run `node app.mjs`:

```js
import { readFile } from "node:fs/promises";
import { createAgent } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";

const definition = JSON.parse(await readFile("agent.json", "utf8"));
const agent = await createAgent(definition, {
  workers: { context: createContextWorker() },
});
try { console.log(await agent.run("Hello Ditto")); }
finally { await agent.close(); }
```

This is a local Context API introduction, not a persistent model Agent. Continue with the [main-router example](../examples/json-agent/router/agent.json) and the [complete conversation configuration](../examples/json-agent/conversation/agent.json), using real inference, Redis Context and SQLite Memory. [Run all JSON examples](../examples/json-agent/README.md).

## 2. Configuration contract

| Field | Meaning |
| --- | --- |
| `version` | Exactly `1`; unsupported versions fail |
| `id` | Agent identifier |
| `graphs` | Named Graph definitions; `main` is required |
| `entry` | Optional `"main"` for a single Graph; cannot accompany `loop` |
| `config` | Optional non-secret JSON values, referenced as `config.*` |
| `loop` | Optional outer execution controller |
| `deployment` | Optional host registry references and Worker bindings |

Unknown structural fields are rejected, including invented permission grants. Identifiers use letters, digits, underscore and hyphen, starting with a letter or underscore. Prototype-related keys are forbidden. Definitions are snapshotted before compilation, bounded to 100,000 JSON values / 64 levels, 32 Subgraph nesting levels and 20,000 expanded leaves across all compiled Graphs. Cyclic dependencies and recursive Subgraphs are rejected.

### Graphs and data flow

A Graph contains a nonempty `nodes` array and an optional `output` expression. Without `output`, it returns the logical node outputs keyed by ID. Nodes may appear in canvas order: the compiler sorts dependencies once.

```json
{
  "id": "observe",
  "type": "INTERACTION.OBSERVE",
  "dependsOn": ["execute"],
  "input": { "result": { "$ref": "nodes.execute" } }
}
```

`dependsOn` describes scheduling; `$ref` maps data. Node inputs can reference `input`, `config` and only their declared `nodes.<dependency>` outputs. Graph outputs can reference all logical nodes. A missing reference fails unless a `default` expression is supplied. These are structural checks; dynamic input/output shapes remain the responsibility of actual Node handlers and application validation. There is no arbitrary JavaScript evaluation or automatic schema-to-handler generation.

For NodeResult-returning operations, add `"require": { "path": "status", "equals": "success" }`. For delivery, use `"accepted"`. Requirements are checked immediately after execution, before dependents are released. A failure stops downstream scheduling; already-started parallel operations settle and external effects are not rolled back. Tool failures may instead be passed to OBSERVE for model feedback by omitting the requirement intentionally.

### Subgraphs

```json
{
  "id": "prepare",
  "kind": "subgraph",
  "graph": "normalize",
  "dependsOn": [],
  "input": { "$ref": "input" }
}
```

`normalize` is another entry in `graphs`, with its own inputs, nodes and projected output. The parent reads it as `nodes.prepare`. Subgraphs are expanded into the same DAG with namespaced leaf IDs such as `prepare/text`. Independent leaves retain parallel execution; parent dependencies constrain the entire child. Reusing a Subgraph creates distinct leaf IDs and data scopes. There is always a `main` Graph; any additional Graph may be referenced as a Subgraph or scheduled by Loop.

## 3. Loop controls Graphs

```json
{
  "entry": "route",
  "maxIterations": 8,
  "state": { "round": 0, "results": [] },
  "steps": {
    "route": {
      "graph": "main",
      "input": { "$ref": "input" },
      "transitions": [
        { "when": { "$op": "eq", "args": [{ "$ref": "result.mode" }, "count"] }, "next": "count" },
        { "end": "completed" }
      ]
    },
    "count": {
      "graph": "count",
      "input": { "$ref": "input" },
      "assign": {
        "round": { "$op": "add", "args": [{ "$ref": "state.round" }, 1] },
        "results": { "$op": "append", "args": [{ "$ref": "state.results" }, { "$ref": "result" }] }
      },
      "transitions": [
        { "when": { "$op": "gte", "args": [{ "$ref": "state.round" }, 2] }, "end": "completed" },
        { "next": "count" }
      ]
    }
  },
  "output": { "$ref": "state.results" }
}
```

This is the `loop` field; the referenced Graphs must be defined. The entry step must execute `main`. Execution order is fixed:

1. Evaluate `state` from `input` and `config`; it must be an object.
2. If optional `while` evaluates to false, stop before executing a Graph. This allows zero iterations.
3. Bind the current step's `input` from `input`, `state`, `config`, then execute its Graph.
4. Evaluate every `assign` value against the old state and projected `result`, then merge assignments atomically.
5. Check transitions in order against the updated state. Each has exactly one of `next` or `end`; the final transition must be unconditional.
6. On `end`, return `output` or the final state. Output can use `termination.reason`. Before any Graph has run, `result` is null.

Conditions must return booleans. `maxIterations` counts outer Graph executions, including repeated stages; expanded Subgraph leaves are part of that same DAG, not extra iterations. Exhaustion throws instead of reporting success. Track business actions separately in state. Use a host cancellation signal for wall-clock limits.

## 4. Expressions

Objects and arrays recursively bind their values. Use these reserved forms:

| Form | Semantics |
| --- | --- |
| `{"$ref":"state.count"}` | Own-property lookup, dot-separated path; numeric array segments supported |
| `{"$ref":"input.optional","default":[]}` | Fallback only when the path is missing, not when it is null |
| `{"$literal":{"$ref":"literal text"}}` | Preserve data that resembles an expression |
| `{"$op":"add","args":[1,2]}` | Checked operation; no implicit numeric coercion |
| `{"$map":{"items":{"$ref":"input.items"},"value":{"$ref":"item.text"}}}` | Map with scoped `item` and `index` |

Binary operators: `eq`, `ne` (structural equality), `lt`, `lte`, `gt`, `gte`, `add`, `subtract`, `and`, `or`, `at`, `append`, `concat` (arrays), `merge` (objects). Unary operators: `not`, `length` (string/array), `first`, `dropFirst`, `isEmpty` (arrays). Boolean operators short-circuit. Invalid types, out-of-range indices and non-finite arithmetic fail.

## 5. Worker registration, tools and permissions

`deployment.workers` contains `{id,use,services?}`. `use` selects an already-supplied host WorkerDefinition; `id` is the Runtime instance ID, not a Worker type. If omitted, all host registry entries register under their keys. `services` optionally selects a host-authorized RuntimeServices profile. No dynamic imports or built-in factory names are assumed.

```ts
const agent = await createAgent(definition, {
  config: loadRuntimeConfig(process.env),
  workers: {
    infer: createInferWorker(),
    interaction: createInteractionWorker({ tools: [readTextTool] }),
    custom: myWorkerDefinition,
  },
  serviceProfiles: {
    readOnly: createRuntimeServices({
      config: trustedWorkspaceConfig,
      sandbox: { tools: ["read_text"], read: true, write: false, execute: false },
    }),
  },
});
```

This wiring fragment assumes imported factories and host-owned resources. In JSON, `{"id":"files","use":"interaction","services":"readOnly"}` registers that Interaction Worker under `files`. `files` is not a built-in FileWorker. `read_text` must really be implemented and registered, using Sandbox filesystem methods to enforce workspace/read permissions.

`deployment.bindings` maps Graph IDs to expanded leaf IDs to Worker instance IDs. For example: `{"main":{"prepare/text":"custom"}}`. Without a binding, Runtime routes by capability. Unknown references, nonexistent leaves and incompatible Worker capabilities fail before execution. Registration failures close previously registered resources.

Credentials, database clients and permission ceilings stay in the host. Only offer Worker definitions and profiles that this user may select. `requiresApproval` and `effects` remain metadata: a trusted controller and the executing tool must verify approval for the actual arguments before an effect. Sandbox checks are cooperative and do not intercept arbitrary SDK/fetch/filesystem calls inside custom JavaScript. [Detailed tool integration](handbook/tools.md).

## 6. Public API and execution boundaries

- `compileAgent(unknown)` returns immutable `definition`, expanded `graphs`, a generator `plan`, and `run(runtime,input,options)`. Compilation constructs executable objects, not TypeScript source files. It does not instantiate Workers or perform IO.
- `await createAgent(unknown, options)` compiles and registers host Workers selected by the JSON. It returns `compiled`, `runtime`, `run(input,options)` and `close()`.
- Both APIs are exported from `@codesoul-co/ditto/runtime` and the package root. `AgentDefinition` and related types support TypeScript authoring. JSON loading is explicit: `JSON.parse(await readFile(...))`.
- `compiled.run` preflights every declared Graph and binding, even unselected branches. Dynamic parameters are validated by handlers. Direct use of `compiled.plan` with `runtime.loop` skips this compiler preflight; prefer `compiled.run`.
- `agent.run` accepts Graph concurrency, cancellation and `onGraph` events. Deployment bindings stay fixed. `compiled.run` can use existing local/remote Workers and explicit execution bindings. Close host-owned runtimes yourself; close factory-owned ones with `agent.close()`.
- The initial compiler uses one generator Loop. It rejects `checkpoint` / `stateCheckpoint`; it does not persist execution stacks. Application Memory can support completed-turn replay, as in the conversation example. For durable in-flight state-machine recovery, use the [advanced state Loop tutorial](handbook/graph-loop.en.md) and [checkpoints](worker-api/checkpoints.md).

## 7. More detailed construction modes

The [three npm acceptance scenarios](../examples/json-agent/npm-scenarios/README.md) cover a five-Worker Graph, a separately packaged third-party Node/Worker, and main routing with multi-node Subgraphs. Run `npm run check:package:json-agents -- --keep` to verify tarball installation, strict types, real tool execution, persistence and failure paths.

Use JSON as the normal entry point. For advanced integration, continue with [code-based Graph/Loop](handbook/graph-loop.en.md), [custom Nodes/Workers](handbook/extensions.en.md), [models](handbook/models.en.md), [Memory](handbook/memory.en.md), and [deployment](handbook/deployment.en.md). New Node contracts and handlers are still implemented in a trusted extension package; JSON selects them by `type` after registration.
