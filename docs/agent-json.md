# Build an Agent from a configuration file

**English** · [简体中文](agent-json.zh-CN.md)

For a fresh npm project, real resources for five Workers, JSON execution and migration to HTTP Workers, follow the [complete walkthrough](agent-from-zero.md). This page documents the configuration protocol.

Build an Agent from a configuration file. The current format is JSON, with `agent.json` as the standard filename: define a required `main` Graph, optional reusable Subgraphs, optional Loop control, non-secret parameters and deployment references. The host supplies real Worker definitions, tools, credentials and authorized services. `createAgent()` compiles the configuration, registers the selected Workers and exposes `run()` / `close()` through the npm package.

The hierarchy stays **Loop → Graph/Subgraph → Node → Worker**. A Subgraph groups a DAG; it never owns a Loop. Conditions, repetition and stopping belong to the outer Loop. Without `loop`, `main` executes once.

## 1. Install and run

Use Node.js 24+, npm 11+, ESM and `@codesoul-co/ditto@0.1.4` or later:

```sh
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto
```

Start with the standard root template [agent_example.json](../agent_example.json). It includes main, a Subgraph, a Loop and Worker registration/bindings; edit ordinary parameters in `config`. After npm installation, copy it:

```sh
cp node_modules/@codesoul-co/ditto/agent_example.json agent.json
```

In the source repository, use `cp agent_example.json agent.json`. The complete configuration follows: an outer Loop runs main, main invokes the load-context Subgraph and then SELECT, and deployment registers and binds the Worker.

```json
{
  "version": 1,
  "id": "agent-example",
  "config": { "selectionLimit": 1, "repetitions": 1 },
  "graphs": {
    "main": {
      "nodes": [
        {
          "id": "prepare", "kind": "subgraph", "graph": "load-context",
          "input": { "$ref": "input" }
        },
        {
          "id": "selected", "type": "CONTEXT.SELECT", "dependsOn": ["prepare"],
          "input": {
            "context": { "$ref": "nodes.prepare" }, "purpose": "infer",
            "limit": { "$ref": "config.selectionLimit" }
          }
        }
      ],
      "output": { "$ref": "nodes.selected.context.items.0.content" }
    },
    "load-context": {
      "nodes": [{
        "id": "loaded", "type": "CONTEXT.LOAD",
        "input": { "sources": [{ "role": "user", "content": { "$ref": "input" } }] }
      }],
      "output": { "$ref": "nodes.loaded" }
    }
  },
  "loop": {
    "entry": "prepare", "maxIterations": 8,
    "state": { "round": 0, "result": null },
    "steps": {
      "prepare": {
        "graph": "main", "input": { "$ref": "input" },
        "assign": {
          "round": { "$op": "add", "args": [{ "$ref": "state.round" }, 1] },
          "result": { "$ref": "result" }
        },
        "transitions": [
          {
            "when": { "$op": "gte", "args": [{ "$ref": "state.round" }, { "$ref": "config.repetitions" }] },
            "end": "completed"
          },
          { "next": "prepare" }
        ]
      }
    },
    "output": { "$ref": "state.result" }
  },
  "deployment": {
    "workers": [{ "id": "context", "use": "context" }],
    "bindings": {
      "main": { "prepare/loaded": "context", "selected": "context" }
    }
  }
}
```

The default is one iteration; set `config.repetitions` to `2` for two. `loop.maxIterations` bounds total Graph executions. Save these runtime settings as `ditto.yaml`:

```yaml
runtime:
  graphConcurrency: 4
workers:
  context:
    policy:
      maxItems: 256
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

| Configuration | Responsibility |
| --- | --- |
| `agent.json` | main, Subgraphs, Node dependencies, Loop transitions/stopping, application parameters and Worker bindings |
| `ditto.yaml` | Runtime and Worker behavior defaults, loaded automatically when creating an Agent / Runtime |
| `.env` | Credentials, endpoints, model selection and deployment permissions; load with `node --env-file=.env app.mjs` when needed |

`createAgent()` / `createDitto()` automatically read `ditto.yaml` from the current working directory (`process.cwd()`) and combine it with the existing `process.env`; no manual loader call or parent-directory search is needed. A missing default file falls back to environment values and built-in defaults; malformed settings and other read errors fail immediately. Each Runtime reads its configuration once at startup, not on every Node call. An explicit `config` completely bypasses automatic loading. Use `config: loadRuntimeConfigFile("path/to/ditto.yaml")` for a custom path or `config: loadRuntimeConfig({})` for built-in defaults only. Load `.env` separately through the application or `node --env-file=.env`; importing the package and calling `compileAgent()` do not read files.

Precedence depends on the parameter; the two files are not merged wholesale:

| Parameter | Effective order (leftmost wins) |
| --- | --- |
| Runtime configuration source | Explicit `createAgent(..., { config })` / `createDitto({ config })` → automatic `./ditto.yaml` and process environment → built-in field defaults |
| Loop budget | `agent.json.loop.maxIterations`, required when `loop` is present. YAML `runtime.loopMaxIterations` only supplies a fallback for code-based Loops without an explicit budget; an Agent without `loop` runs main once |
| Graph concurrency | `agent.run(input, { concurrency })` → YAML `runtime.graphConcurrency` → built-in `Infinity` |
| Memory query limit | Node input `limit` (which can be set in `agent.json`) → Worker factory `defaults.queryLimit` → YAML `workers.memory.queryLimit` → built-in `100` |
| Application parameters | `agent.json.config` is only available through `$ref: "config.…"`; it does not override YAML or the host's Runtime `config` |
| Context policy | Explicit Worker factory `policy` fields → YAML `workers.context.policy` → built-in defaults; `createContextWorker()` uses Runtime policy automatically |

Environment variables supply credentials, addresses, model selection and deployment permissions; YAML supplies behavior defaults. They own different fields, with no universal “environment overrides JSON/YAML” rule. Other Node parameters follow their respective contracts; default overrides cannot grant tool permissions. The host still creates and injects databases, tools and service profiles.

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

Register shared Node implementations and Worker instances once. Nodes in multiple Subgraphs can use the same `type` and bind to the same Worker instance ID to reuse handlers and resources. Loop iterations and concurrent runs of the same Agent do not register additional Workers. Expanded leaves describe separate execution positions; each invocation keeps its own inputs and results, without automatically caching or reusing another invocation's results. A shared Worker's implementation must handle concurrent access to its mutable resources.

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

The Graph ID identifies the execution entry: when main invokes a Subgraph, put its expanded paths under `bindings.main`. The Subgraph's own binding table applies when Loop schedules that Graph directly. For example, `{"main":{"left/text":"custom","right/text":"custom"}}` binds nodes in two Subgraph calls to the same `custom` Worker. Standalone Subgraph bindings are not inherited by the parent.

Credentials, database clients and permission ceilings stay in the host. Only offer Worker definitions and profiles that this user may select. `requiresApproval` and `effects` remain metadata: a trusted controller and the executing tool must verify approval for the actual arguments before an effect. Sandbox checks are cooperative and do not intercept arbitrary SDK/fetch/filesystem calls inside custom JavaScript. [Detailed tool integration](handbook/tools.md).

## 6. Public API and execution boundaries

- `compileAgent(unknown)` returns immutable `definition`, expanded `graphs`, a generator `plan`, `sourceMap`, `runGraph(name,runtime,input,options)`, and `run(runtime,input,options)`. Compilation constructs executable objects, not TypeScript source files. It does not instantiate Workers or perform IO.
- `await createAgent(unknown, options)` compiles and registers host Workers selected by the JSON. It returns `compiled`, `runtime`, `run(input,options)` and `close()`.
- Both APIs are exported from `@codesoul-co/ditto/runtime` and the package root. `AgentDefinition` and related types support TypeScript authoring. JSON loading is explicit: `JSON.parse(await readFile(...))`.
- `compiled.run` preflights every declared Graph and binding, even unselected branches. Dynamic parameters are validated by handlers. Direct use of `compiled.plan` with `runtime.loop` skips this compiler preflight; prefer `compiled.run`.
- `agent.run` accepts Graph concurrency, cancellation and `onGraph` events. Deployment bindings stay fixed. `compiled.run` can use existing local/remote Workers and explicit execution bindings. Close host-owned runtimes yourself; close factory-owned ones with `agent.close()`.
- `stateCheckpoint` persists the configured Agent cursor, state and inner Graph checkpoints. Awaited `onBoundary` callbacks can update state and request a pause. `runGraph` independently executes a Graph with output projection, binding preflight and Graph checkpoints. Schema, structured diagnostics and expanded-node mappings support editors. See [execution, recovery and editor integration](agent-execution.md) for contracts, version availability and a runnable example.

## 7. More detailed construction modes

The [three npm acceptance scenarios](../examples/json-agent/npm-scenarios/README.md) cover a five-Worker Graph, a separately packaged third-party Node/Worker, and main routing with multi-node Subgraphs. Run `npm run check:package:json-agents -- --keep` to verify tarball installation, strict types, real tool execution, persistence and failure paths.

Use JSON as the normal entry point. For advanced integration, continue with [code-based Graph/Loop](handbook/graph-loop.en.md), [custom Nodes/Workers](handbook/extensions.en.md), [models](handbook/models.en.md), [Memory](handbook/memory.en.md), and [deployment](handbook/deployment.en.md). New Node contracts and handlers are still implemented in a trusted extension package; JSON selects them by `type` after registration.
