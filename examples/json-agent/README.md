# JSON Agent examples

**English** · [简体中文](README.zh-CN.md) · [Configuration reference](../../docs/agent-json.md)

Start with `agent.json`. The host uses only public npm APIs to supply Worker implementations and resources; Graphs, Subgraphs, Loop control, ordinary parameters and registration/binding references live in JSON.

| Example | Configuration | Host | Scope |
| --- | --- | --- | --- |
| Standard template | [agent_example.json](../../agent_example.json) | [quickstart.ts](quickstart.ts) with a config path | main + Subgraph, multiple nodes, Loop state/budget and Worker binding |
| Single main Graph | [agent.json](agent.json) | [quickstart.ts](quickstart.ts) | Two-node LOAD → SELECT API introduction, no model or persistence |
| main router + Subgraphs + Loop | [router/agent.json](router/agent.json) | [router.ts](router.ts) | Custom typed Nodes/Worker, tool registration, restricted services, branching and repeated execution |
| Complete conversation Agent | [conversation/agent.json](conversation/agent.json) | [conversation.ts](conversation.ts) | Real model, scoped Redis Context, file SQLite Memory, latest-turn replay and answer files |
| Three npm acceptance scenarios | [Configurations and instructions](npm-scenarios/README.md) | [host.ts](npm-scenarios/host.ts) | Five Workers in a 13-node Graph, an independent extension package, main routing and multiple functional Subgraphs |

## Start from the standard template

Copy and run it in the source repository:

```sh
cp agent_example.json agent.json
node examples/json-agent/quickstart.ts 'Hello Ditto' agent.json
```

Alternatively, `npm run example:json:template` runs the original template. In an independent npm project, copy `node_modules/@codesoul-co/ditto/agent_example.json`; use the host from the [configuration guide](../../docs/agent-json.md). Keep the template as a reference and edit your own `agent.json`.

The template executes `main → load-context Subgraph (LOAD) → SELECT`. The outer Loop runs once by default; set `config.repetitions` to 2 to run twice. `loop.maxIterations` bounds execution, and `deployment` selects the host's Context Worker. Output is `Hello Ditto`. This is a model-free composition template; the complete example below adds model and persistent resources.

## Run the local compiler examples

```sh
npm ci
node examples/json-agent/quickstart.ts
node examples/json-agent/router.ts 'A😀' count
node examples/json-agent/router.ts ' Hello ' echo
```

Expected outputs are `Hello Ditto`, `[2,2]`, and `["Hello"]`. The router's main Graph invokes the normalization Subgraph, then a custom routing Node. Loop selects count or echo; count repeats twice through TOOL → OBSERVE. Only the selected branch executes. The Interaction Worker exposes a real Unicode-counting tool; its host-authorized profile allows that tool only. These are deterministic compiler/adapter examples, not model end-to-end acceptance.

## Run the complete Agent

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
cp examples/package-basics/.env.example .env
# Configure the real provider, model, network origin and Redis.
redis-server --bind 127.0.0.1 --port 6379
```

In another terminal:

```sh
node --env-file=.env examples/json-agent/conversation.ts --session alice --turn turn-1 --prompt 'Remember my project code: orchid-42.'
node --env-file=.env examples/json-agent/conversation.ts --session alice --turn turn-2 --prompt 'What is my project code?'
```

`main` is a small router backed by the history Subgraph and an application validation Node. The JSON Loop selects new-answer or replay, then write/update and delivery. Context is rebuilt from SQLite history each new turn, loaded with Redis scope, selected for inference and updated afterward. Redis failures fail explicitly; no in-memory fallback occurs. Answers are written under `.examples-json-agent-tasks/alice/answers/`; `memory.sqlite` preserves conversation history across processes.

The host validates session/turn/prompt, owns credentials and connections, and defines PREPARE/FINALIZE contracts. Those Nodes enforce application input and result semantics; they do not schedule Graphs or hide model calls. The JSON holds every stage, branch and binding. The model must return a nonempty text answer; Memory must succeed before delivery. Matching latest-turn replay redelivers the saved answer without another model call; reusing the ID with different input fails. Run one request at a time per session. This example retains five prior turns and latest-turn replay, not arbitrary in-flight recovery or tenant authentication.

## npm consumer and acceptance

In an independent ESM project, install `@codesoul-co/ditto` and `redis@6.2.1`. Copy `examples/json-agent/`, `examples/_shared/tools/package-basics.ts` and the storage files listed in the [package basics guide](../package-basics/README.md), preserving paths. No source aliases or internal imports are needed. Importing the host modules does not start tasks.

```sh
npm run check
npm run check:package:basics
npm run check:package:basics:live
npm run check:package:json-agents -- --keep
```

The package check installs the built tarball outside the repository, runs both router branches, checks strict types and silent imports, and executes README snippets. Live mode additionally runs both code-based and JSON conversations with real providers, Redis and SQLite; checks cross-process history, Redis expiry/failure, changed-input rejection, replay and delivered artifacts. Unit tests are not substituted for live acceptance.

For model-selected actions, replace routing input with inference results and define tool Graphs plus OBSERVE feedback in the same outer Loop. Tools and approval remain host-owned; see the [JSON reference](../../docs/agent-json.md) and [advanced ReAct example](../patterns/react/README.md).
