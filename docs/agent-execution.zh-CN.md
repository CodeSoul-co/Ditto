# 配置化 Agent 的执行、恢复与编辑器接入

[English](agent-execution.md) · **简体中文** · [配置协议](agent-json.zh-CN.md)

这些新增能力已进入源码构建，已发布的 `0.1.4` 尚不包含它们。新包发布前可使用文末的 tarball 验收命令。现有配置文件及 `agent.run(input)` 用法保持兼容。

## 单独运行 Graph

```ts
import { compileAgent } from '@codesoul-co/ditto';

const compiled = compileAgent(definition);
const output = await compiled.runGraph('research', runtime, input, {
  concurrency: 2,
  workers: { search: 'search-worker', summarize: 'infer-worker' },
});
```

`definition`、`runtime`、已注册 Worker 和 `input` 由应用提供。`runGraph` 可以独立运行任意命名 Graph，包括 Subgraph，接收该图自己的输入。它只预检所选入口展开后的叶子与绑定，返回配置声明的输出投影，不要求其他 Graph 的 Worker 已注册。省略绑定时使用 `deployment.bindings[name]`；显式 `workers` 替换该入口的绑定表。父图的展开节点绑定不会继承子图独立执行时的绑定表。

应用保留自己的持久外层 Loop 时，可以通过这个入口逐步迁移内部图。`compiled.graphs[name]` 仍是原始执行 DAG，直接运行只返回展开叶子输出，不会应用配置的输出投影。

`runGraph` 接受 `{ checkpoint: { version, resume?, save } }`。编译器将完整定义及选中的绑定纳入检查点版本；宿主 `version` 仍需覆盖 Worker 实现及相关资源版本。配置、绑定、输入或宿主版本变化都会拒绝恢复。本地／远端 Worker 的注册方式与 `compiled.run` 一致。

## 持久化配置化 Loop

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
    // 下一个执行位置已经保存，将控制权交还宿主。
    console.log(error.checkpoint.state.step);
  } else throw error;
}
```

这是接线片段，`store` 和 `inbox` 由应用实现，不是 Ditto 隐式提供的服务。`AgentRunOptions`、`AgentCheckpoint`、`AgentCheckpointOptions`、`AgentBoundary`、`AgentBoundaryDecision` 均从根入口和 `/runtime` 导出。

检查点状态包括：

| 字段 | 含义 |
| --- | --- |
| `definitionHash`、`inputHash` | 编译定义／绑定及原始输入的身份校验 |
| `iteration`、`step` | 已完成 Graph 次数与当前或下一个 Loop 步骤 |
| `state`、`result` | 显式 Loop 状态和最近一次 Graph 的投影结果 |
| `phase` | `ready`、`running`、`boundary`、`completed` |
| `graphCheckpoint` | 执行中的已确认叶子输出及未确认的调用意图 |
| `termination` | 已结束 Loop 的终止原因 |

外层封装包含作用域、宿主版本和完整性摘要。应用需另存原始输入，恢复时再次传入。迭代预算不会因重启归零；已完成检查点直接返回该次执行的投影结果，不再执行 Node。没有 `loop` 的配置也支持同样的单次 main Graph 恢复。

`save` 必须在最新检查点完成持久替换后才返回。每次保存都会被等待；保存失败会停止后续调度。文件使用原子替换，数据库使用事务；共享存储必须通过租约或 compare-and-swap 保证同一执行 ID 只有一个写入者。失败后始终重新读取最新持久记录，不要拿旧检查点重试已变化的资源。不可信存储还需要宿主验证真实性：摘要只能检测损坏，不能防止恶意重写。

`agent.json.version` 是配置格式版本，不是宿主版本或执行 ID。编译器自动计算配置内容哈希，配置变化会拒绝恢复。资源重连、凭证、外部快照、消息存储和迁移策略由宿主管理。

`compiled.plan` 保留同步生成器形式，兼容原有代码接入。直接调用 `runtime.loop(compiled.plan, ...)` 不提供配置化 Agent 持久化或绑定预检。Agent 请使用 `agent.run`／`compiled.run` 的 `stateCheckpoint`；独立 Graph 使用 `runGraph` 的 `checkpoint`。任意 JavaScript 生成器仍不可序列化。

## 在边界等待、更新或暂停

每次 Graph 完成后的顺序是：

1. 投影 Graph 输出，执行步骤的 `assign`。
2. 持久保存 `boundary` 状态，等待 `onBoundary`。
3. 合并返回的浅层 `update`，用更新后的状态选择转移分支。
4. 保存下一个 `ready` 或 `completed` 位置；继续运行，或在请求 `pause` 时抛出 `AgentPausedError`。

边界参数是不可变 JSON 快照。`boundary.id` 由执行 ID 与已完成迭代数构成，同一个边界重试时保持不变。回调在 Graph 之后执行，不在第一个 Graph 之前执行；零迭代 Loop 不调用边界回调。`while` 在下一个 Graph 之前检查。回调失败保留已保存的边界，且不启动后续 Graph。恢复已成功保存的暂停时，会跳过该次边界决策，从保存的位置继续。暂停要求配置 `stateCheckpoint`；没有持久化的等待回调仍可在当前进程中接纳状态更新。

消息接纳必须按边界 ID 幂等。不要在新状态保存之前破坏性确认或删除消息。可以把消息游标／回执放入状态补丁，使持久确认与 `save` 保持一致。回调或保存失败后，宿主可能再次收到同一边界。此接口不会回滚已提交工具动作、运行消息队列、授予权限或中途打断 Node 操作。取消仍使用 `signal`；`onGraph` 保持事件通知用途，不会被等待。Runtime 关闭会等待已接纳的 Agent 执行，包括正在等待的边界；宿主须先让等待中的回调结束，关闭才能完成。

## 核对未知副作用

开启 Graph 检查点后，Ditto 会在每个执行波次**派发之前**，将对应 Node ID 持久写入 `uncertain`。该波次结束后，成功输出替换这些意图。进程意外退出、传输失败或完成状态保存失败，都可能留下未确认意图。恢复时抛出 `UncertainGraphCheckpointError`，阻止任何未确认 Node 自动重放。独立 Graph 也遵循这个协议。

意图可能对应尚未开始、仍在远端运行或已经提交的动作；只有宿主能区分。核对外部回执或事务后，显式处理：

```ts
import { checkpointState, reconcileGraphCheckpoint } from '@codesoul-co/ditto';

const graphCheckpoint = reconcileGraphCheckpoint(saved.state.graphCheckpoint, {
  'publish/write': { output: verifiedWorkerOutput },
  // 只有核实重放安全后，才使用 { retry: true }。
});
const reconciled = checkpointState(saved.scope, saved.version, {
  ...saved.state, graphCheckpoint,
});
await store.replaceDurably(executionId, reconciled);
// 用原始输入和 reconciled stateCheckpoint 再次调用 agent.run。
```

使用准确的展开叶子 ID；确认完成时提供完整 Node 输出。恢复时会重新检查输出约束。未知 ID 或错误的处理格式会被拒绝，未处理完的意图仍会阻止恢复。独立 Graph 则直接处理它的 `GraphCheckpoint`。不要为了绕过错误而直接清空意图。外部效果需要协调时，仍应使用幂等键或资源事务；本协议不承诺外部操作 exactly-once。旧实现产生的检查点也不会自动获得执行前记录的保证。

## 编辑器接入

官方 Draft 2020-12 Schema 通过 `agentSchema` 和 `@codesoul-co/ditto/agent.schema.json` 导出。编辑器可以关联已安装包中的文件：

```json
{ "$schema": "./node_modules/@codesoul-co/ditto/dist/runtime/agent.schema.json" }
```

将这个字段加入完整 Agent 配置即可。文档构建还会在站点根目录提供 `agent.schema.json`。Schema 校验结构及表达式形式；编译器检查图引用、依赖环、作用域和展开限制；运行前检查已注册能力。Schema 不能代替后两步。

```ts
import { validateAgent, compileAgent, AgentValidationError } from '@codesoul-co/ditto';
const diagnostics = validateAgent(definition); // [] 或首个可处理错误
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

诊断 `path` 是 RFC 6901 JSON Pointer。配置能够定位时附带 `graphId`／`nodeId`。错误码包括 `UNKNOWN_FIELD`、`INVALID_VALUE`、`INVALID_REFERENCE`、`INVALID_EXPRESSION`、`DUPLICATE_NODE`、`UNKNOWN_NODE`、`UNKNOWN_GRAPH`、`CYCLIC_GRAPH`、`LIMIT_EXCEEDED`。`validateAgent` 与编译器使用同一套校验，无须创建 Worker 或执行 IO。

`sourceMap` 按入口 Graph 和展开叶子 ID 索引。同一个 Subgraph 多次调用时，源配置路径相同，调用路径不同；编辑器可按源路径分组，实现逻辑节点到多个展开节点的高亮。映射仅在编译时构建一次，不额外创建 Node 或 Worker 实例。

## 可运行的 npm 示例

[配置文件](worker-api/examples/runtime/configured-recovery.agent.json) 包含 main、由两个 Subgraph 调用组成的 work Graph，以及可复用的双 Node stage。[宿主代码](worker-api/examples/runtime/configured-recovery.ts) 注册一个 Interaction Worker，并提供原子文件检查点。这是确定性的控制面示例，不需要模型或数据库，也不是五 Worker 产品端到端验收。完整资源接入见[从零构建 Agent](agent-from-zero.zh-CN.md)。

```sh
# 使用源码构建的包，或之后发布且包含这些 API 的 npm 包。
node docs/worker-api/examples/runtime/configured-recovery.ts /tmp/ditto-demo pause
node docs/worker-api/examples/runtime/configured-recovery.ts /tmp/ditto-demo
node docs/worker-api/examples/runtime/configured-recovery.ts /tmp/ditto-demo
```

使用新目录，并保证只有一个写入者。三次工具调用数量应为 `1`、`2`、`0`：路由后暂停，带着宿主更新的状态恢复，然后读取已完成结果。未知操作会保持阻塞，等待宿主显式核对。

仓库验收命令为 `npm run check:package:agent-recovery`。它在仓库外安装打包产物，检查无路径别名的严格 TypeScript、Schema 导出、独立 Subgraph 执行，以及上述三个独立 CLI 进程。单元测试还会在子进程完成文件写入后立即退出，确认恢复不会自动重放。
