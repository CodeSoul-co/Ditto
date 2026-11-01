# Build Agents from configuration: npm acceptance scenarios

**English** · [简体中文](README.zh-CN.md) · [configuration examples](../README.md)

For a fresh project with published npm packages, real resources for five Workers, and local/HTTP execution of the same JSON, follow the [complete walkthrough](../../../docs/agent-from-zero.md). The `single` scenario needs no third-party extension; `custom` / `routed` require the example extension. `openScenarioResources()` supports process-level reuse, and `remote.mjs` provides HTTP server/controller modes.

Run `node --env-file=.env scripts/check-json-agent-package.ts --registry --keep` to verify published versions; the default command still installs local tarballs. Additional checks cover the CLI without an extension, unchanged JSON over real HTTP, server-owned resources for five Workers and incorrect tokens.


These scenarios install Core, Retrieval and a separately built third-party Worker tarball outside the repository. Hosts supply implementations and resources through public exports; `agent.json` owns orchestration. No registry publication, source aliases or npm links are involved.

| Scenario | Configuration | Execution |
| --- | --- | --- |
| One Agent, one large Graph | [single/agent.json](single/agent.json) | 13 nodes covering Context, Memory, Infer, Interaction and Retrieval: search, context, native model tool request, execution, observation, final inference, persistence and file delivery |
| Third-party Nodes and Worker | [custom/agent.json](custom/agent.json) | 7 nodes combining an independently installed extension's NORMALIZE and FORMAT with Memory, Context and Interaction |
| main router and functional Subgraphs | [routed/agent.json](routed/agent.json) | main runs NORMALIZE → ROUTE; the outer Loop chooses work or recall. work expands research (5 nodes), act (3) and finish (5); recall contains 4 nodes |

Retrieval comes from `@codesoul-co/ditto-retrieval`. The application search provider reads `guide.json`; the real tool counts Unicode code points. Model requests, Redis Context and file SQLite Memory use real resources. See [host.ts](host.ts) and [extension/index.ts](extension/index.ts).

## Run from the repository

Use Node 24+, npm 11+ and installed repository dependencies. Configure the model, credentials, network allowlist and Redis URL in `.env` using the [environment template](../../package-basics/.env.example), start your Redis instance, then run:

```sh
npm run check:package:json-agents -- --keep
```

`--keep` retains the external consumer directory printed by the script. The repository report is `.examples-json-agent-package-live-results.json`; the consumer keeps `task/results.json`, `task/memory.sqlite` and `task/answers/`. Credentials are inherited through the environment; `.env` is not copied and secrets are not written to configurations or reports.

Assertions cover actual model tool arguments, invocation counts, final artifacts, expanded node paths, skipped branches, JSON Loop budgets, unregistered Workers, unknown Nodes, invalid bindings, denied tool permissions, failed SQLite writes and unavailable Redis. A separate process retrieves a completed result from SQLite after Redis expiry, rebuilding Context without repeating inference or tools. This is completed-result recovery, not arbitrary in-flight checkpoint restoration.

## Independent npm application

1. Install `@codesoul-co/ditto`, `@codesoul-co/ditto-retrieval` and `redis`, or install local tarballs before publication.
2. Build an extension with `defineNode`, `defineWorker` and `NodeContractMap` augmentation. This fixture compiles `extension/index.ts` to JavaScript and declarations, packs it and installs `@ditto-example/text-worker` separately. That fixture package is not published.
3. Copy this host, CLI, your selected `agent.json`, `_shared/tools/storage/` and `_shared/tools/package-basics.ts`, preserving relative paths. Import the installed extension and pass `createTextWorker()` to the host. JSON `deployment.workers[].use` selects the trusted host registry; `bindings` selects Worker instances for nodes.
4. Supply `input.json` and the task directory's `guide.json`, then call `runScenario()` or the CLI. The retained consumer already contains a replayable request:

```sh
# Inside the printed consumer directory, with environment variables supplied by your application.
node examples/json-agent/npm-scenarios/cli.mjs \
  examples/json-agent/npm-scenarios/routed/agent.json \
  task/recall-input.json task
```

JSON may select host-authorized `count-only` / `no-tools` profiles, but cannot create tool implementations, credentials or new permissions. JSON changes require no SDK rebuild; new implementations must first be installed and registered by the host.
