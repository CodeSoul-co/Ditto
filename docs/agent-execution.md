# Configured Agent execution, recovery and editor integration

**English** · [简体中文](agent-execution.zh-CN.md) · [Configuration](agent-json.md)

These additions are available in the source build; the published `0.1.4` package does not include them. Use the installed tarball acceptance command below until a newer package is released. Existing configuration files and `agent.run(input)` continue to work.

## Run a Graph independently

```ts
import { compileAgent } from '@codesoul-co/ditto';

const compiled = compileAgent(definition);
const output = await compiled.runGraph('research', runtime, input, {
  concurrency: 2,
  workers: { search: 'search-worker', summarize: 'infer-worker' },
});
```

`definition`, `runtime`, registered Workers and `input` are supplied by your application. `runGraph` accepts any named Graph, including a Subgraph, with its own input. It preflights only that entry's expanded leaves and selected bindings, then returns its configured output projection. Unrelated Graphs need not have registered Workers. Omitted bindings use `deployment.bindings[name]`; an explicit `workers` map replaces that entry's map. A parent's expanded leaf bindings do not inherit the child's independent binding table.

Use this API when the application retains its own persistent outer Loop. `compiled.graphs[name]` remains available as the raw execution DAG, whose result contains expanded leaf outputs; it does not apply the configuration's output projection.

`runGraph` accepts `{ checkpoint: { version, resume?, save } }`. The compiler incorporates the complete definition and selected bindings into the checkpoint version. Your `version` must still cover host Worker implementations and relevant resource versions. Restore rejects changed configuration, bindings, input or host version. Register local or remote Workers exactly as for `compiled.run`.

## Persist the configured Loop

```ts
import { AgentPausedError } from '@codesoul-co/ditto';

try {
  const result = await agent.run(originalInput, {
    stateCheckpoint: {
      id: executionId,
      version: 'workers-v3/resources-v2',
      ...(saved ? { resume: saved } : {}),
      save: checkpoint => store.replaceDurably(executionId, checkpoint),
    },
    onBoundary: async boundary => {
      const decision = await inbox.decisionFor(boundary.id);
      return { update: decision.statePatch, pause: decision.pause };
    },
  });
} catch (error) {
  if (error instanceof AgentPausedError) {
    // The next execution position is already saved. Return control to the host.
    console.log(error.checkpoint.state.step);
  } else throw error;
}
```

This integration fragment uses an application-owned `store` and `inbox`. Neither is an implicit Ditto service. `AgentRunOptions`, `AgentCheckpoint`, `AgentCheckpointOptions`, `AgentBoundary` and `AgentBoundaryDecision` are exported from the root and `/runtime`.

Checkpoint state contains:

| Field | Meaning |
| --- | --- |
| `definitionHash`, `inputHash` | Compiled definition/bindings identity and original input identity |
| `iteration`, `step` | Completed Graph count and current or next Loop step |
| `state`, `result` | Explicit Loop state and latest projected Graph result |
| `phase` | `ready`, `running`, `boundary` or `completed` |
| `graphCheckpoint` | During execution, confirmed leaf outputs and unresolved dispatch intents |
| `termination` | Completed Loop's termination reason |

The envelope contains scope, host version and integrity digest. Keep the original input with your application record and supply it again on resume. Loop budgets survive restarts. Completed checkpoints return the saved execution's projected result without executing Nodes again. A configuration without `loop` has the same recovery behavior for its single main Graph.

`save` must durably replace the latest checkpoint before resolving. Every save is awaited; a failed save stops further admissions. Use atomic file replacement or a database transaction. A shared store must enforce a single writer per execution ID using a lease or compare-and-swap. Always reload the latest durable record after a failure; never reuse an older checkpoint against changed resources. Authenticate stored checkpoints if storage is untrusted: a digest detects corruption, not malicious rewriting.

`agent.json.version` describes the configuration format. It is not the host version or the execution ID. The compiler hashes configuration content automatically; changing it rejects resume. Resource reconnection, credentials, external snapshots, message storage and migration policy remain host responsibilities.

`compiled.plan` remains a synchronous generator for existing code integrations. Calling `runtime.loop(compiled.plan, ...)` does not provide configured-Agent persistence or preflight. Use `agent.run` / `compiled.run` with `stateCheckpoint`; use `runGraph` with `checkpoint` for an independent Graph. Arbitrary generator plans still cannot be serialized.

## Await, update or pause at a boundary

The order after each Graph is:

1. Project Graph output and apply the step's `assign`.
2. Persist the `boundary` state, then await `onBoundary`.
3. Apply the returned shallow `update` patch and evaluate transitions using the updated state.
4. Save the next `ready` or `completed` position; either continue or throw `AgentPausedError` if `pause` was requested.

Boundary data is an immutable JSON snapshot. `boundary.id` combines execution ID and completed iteration, remaining stable when the same boundary is retried. The hook runs after a Graph, not before the first Graph; a zero-iteration Loop has no boundary callback. The `while` condition is checked before the next Graph. A hook failure leaves the saved boundary for host recovery and starts no further Graph. Resuming a successfully saved pause skips that boundary decision and continues from the saved position. Pausing requires `stateCheckpoint`; an awaited callback without persistence can still accept state updates during the current run.

An inbox decision must be idempotent by boundary ID. Do not destructively acknowledge messages before the resulting state is saved. Keep an inbox cursor or receipt in the state patch and make durable acknowledgment consistent with `save`. If the hook or save fails, the host may receive the same boundary again. This API does not roll back committed tool actions, run a queue, grant permissions or interrupt a Node halfway through an operation. `signal` handles cancellation; `onGraph` remains telemetry and is not awaited. Runtime shutdown drains an accepted Agent run, including an awaited boundary; the host must resolve its waiting callback before shutdown can finish.

## Reconcile unknown effects

With Graph checkpointing enabled, Ditto durably records a wave's Node IDs in `uncertain` **before dispatch**. Successful outputs replace those intents after the wave settles. A hard process exit, transport failure or failed completion save can leave unresolved intents. On restore, `UncertainGraphCheckpointError` stops execution before any unresolved Node is replayed. Independent Graph execution has the same behavior.

An intent may describe an operation that never started, one still running remotely, or one that already committed. Only the host can distinguish them. After checking the external receipt or transaction, reconcile explicitly:

```ts
import { checkpointState, reconcileGraphCheckpoint } from '@codesoul-co/ditto';

const graphCheckpoint = reconcileGraphCheckpoint(saved.state.graphCheckpoint, {
  'publish/write': { output: verifiedWorkerOutput },
  // Or { retry: true } only after verifying that replay is safe.
});
const reconciled = checkpointState(saved.scope, saved.version, {
  ...saved.state, graphCheckpoint,
});
await store.replaceDurably(executionId, reconciled);
// Resume agent.run with the original input and reconciled stateCheckpoint.
```

Use the exact expanded leaf ID, and supply the full Node output when confirming completion. Output requirements are rechecked on resume. Unknown or malformed resolutions are rejected; unresolved intents continue to block restore. For an independent Graph, reconcile its `GraphCheckpoint` directly. Never clear an intent merely to bypass the error. External idempotency keys and transactions remain necessary where effects must be coordinated; this protocol does not promise exactly-once external execution. Old checkpoints created before intent recording do not acquire this guarantee retroactively.

## Editor integration

The official Draft 2020-12 schema is exported as `agentSchema` and as `@codesoul-co/ditto/agent.schema.json`. Editors can associate a configuration with the installed file:

```json
{ "$schema": "./node_modules/@codesoul-co/ditto/dist/runtime/agent.schema.json" }
```

Add this property to the otherwise complete Agent configuration. The documentation build also serves `agent.schema.json` at the site root. Schema validation checks structure and expression forms. The compiler checks Graph references, dependency cycles, scopes and expansion limits; runtime preflight checks registered capabilities. Schema validation alone does not replace either step.

```ts
import { validateAgent, compileAgent, AgentValidationError } from '@codesoul-co/ditto';
const diagnostics = validateAgent(definition); // [] or the first actionable diagnostic
// { code, path: '/graphs/main/nodes/0/input/$ref', message, graphId, nodeId }

try { compileAgent(definition); }
catch (error) {
  if (error instanceof AgentValidationError) editor.show(error.diagnostic);
  else throw error;
}
const source = compiled.sourceMap.main['research/search'];
// { graphId: 'research', nodeId: 'search', path: '/graphs/research/nodes/0',
//   invocationPath: ['research', 'search'] }
```

Diagnostic `path` is an RFC 6901 JSON Pointer. `graphId` / `nodeId` are included when the configuration identifies them. Codes include `UNKNOWN_FIELD`, `INVALID_VALUE`, `INVALID_REFERENCE`, `INVALID_EXPRESSION`, `DUPLICATE_NODE`, `UNKNOWN_NODE`, `UNKNOWN_GRAPH`, `CYCLIC_GRAPH` and `LIMIT_EXCEEDED`. The compiler and `validateAgent` use the same validation logic; diagnostics do not require Worker instantiation or IO.

`sourceMap` is indexed by entry Graph and expanded leaf ID. Reused Subgraphs have the same source pointer but different invocation paths. An editor can group entries by source pointer for logical-to-expanded highlighting. Mapping metadata is built once during compilation; it does not create extra Node or Worker instances.

## Runnable package example

The [configuration](worker-api/examples/runtime/configured-recovery.agent.json) uses main, a two-Subgraph work Graph and a reusable two-Node stage. The [host](worker-api/examples/runtime/configured-recovery.ts) registers one Interaction Worker and provides an atomic file checkpoint. This deterministic control-plane example needs no model or database and is not a five-Worker product end-to-end test. For complete resource integration, use [Agent from zero](agent-from-zero.md).

```sh
# Run with a source-built package or an installed package containing these APIs.
node docs/worker-api/examples/runtime/configured-recovery.ts /tmp/ditto-demo pause
node docs/worker-api/examples/runtime/configured-recovery.ts /tmp/ditto-demo
node docs/worker-api/examples/runtime/configured-recovery.ts /tmp/ditto-demo
```

Use a fresh directory and one writer. Expected tool-call counts are `1`, `2`, `0`: pause after routing, resume with the host's updated value, then replay the completed result. The example intentionally keeps unknown operations blocked for explicit host reconciliation.

Repository acceptance: `npm run check:package:agent-recovery`. It packs and installs the library outside the repository, checks strict TypeScript without path aliases, schema exports, independent Subgraph execution, and the three separate CLI processes above. Unit tests additionally terminate a child process immediately after a file effect and verify that recovery does not replay it automatically.
