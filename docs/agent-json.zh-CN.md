# 使用 agent.json 构建 Agent

[English](agent-json.md) · **简体中文**

先写一份 `agent.json`：定义必需的 `main` Graph、可选的可复用 Subgraph、外层 Loop、普通参数和部署引用。宿主提供真实 Worker、工具、凭证和获准的资源配置。通过 npm 包的 `createAgent()` 编译配置、注册选定 Worker，再调用 `run()` / `close()`。

分层保持 **Loop → Graph/Subgraph → Node → Worker**。Subgraph 只封装 DAG，不拥有 Loop。条件、重复与结束由外层 Loop 控制。不配置 `loop` 时，只执行一次 `main`。

## 1. 安装与运行

使用 Node.js 24+、npm 11+、ESM 和 `@codesoul-co/ditto@0.1.3` 或更高版本：

```sh
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto
```

推荐从仓库根目录的标准模板 [agent_example.json](../agent_example.json) 开始。模板包含 main、Subgraph、Loop 和 Worker 注册绑定，普通参数在 `config` 中调整。安装 npm 包后复制：

```sh
cp node_modules/@codesoul-co/ditto/agent_example.json agent.json
```

在源码仓库中则执行 `cp agent_example.json agent.json`。下面是更小的单图多节点版本（LOAD → SELECT），也可保存为 `agent.json`，两种配置共用下方宿主代码。

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

保存为 `app.mjs`，执行 `node app.mjs`：

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

这是本地 Context API 入门，不是持久化模型 Agent。接下来运行 [main 路由示例](../examples/json-agent/router/agent.json)，以及使用真实模型、Redis Context 和 SQLite Memory 的[完整会话配置](../examples/json-agent/conversation/agent.json)。[全部 JSON 示例运行方法](../examples/json-agent/README.zh-CN.md)。

## 2. 配置契约

| 字段 | 含义 |
| --- | --- |
| `version` | 固定为 `1`；不支持的版本报错 |
| `id` | Agent 标识 |
| `graphs` | Graph 定义集合；必须包含 `main` |
| `entry` | 单图可选写 `"main"`，不能与 `loop` 同时出现 |
| `config` | 可选的非敏感 JSON 参数，通过 `config.*` 引用 |
| `loop` | 可选的外层执行控制 |
| `deployment` | 可选的宿主注册表引用和 Worker 绑定 |

未知结构字段会被拒绝，包括自行添加的权限授予字段。标识符由字母、数字、下划线和连字符组成，以字母或下划线开头；禁止原型相关键。配置在编译前被复制并冻结，限制为 100,000 个 JSON 值、64 层 JSON 深度、32 层 Subgraph 嵌套，以及所有编译图合计 20,000 个展开叶子。循环依赖和递归 Subgraph 会被拒绝。

### Graph 与数据流

Graph 包含非空 `nodes` 数组和可选 `output` 表达式。省略 `output` 时返回按逻辑节点 ID 索引的结果。节点可以按画布顺序保存，编译器统一进行拓扑排序。

```json
{
  "id": "observe",
  "type": "INTERACTION.OBSERVE",
  "dependsOn": ["execute"],
  "input": { "result": { "$ref": "nodes.execute" } }
}
```

`dependsOn` 定义执行依赖，`$ref` 定义字段映射。节点输入只能访问 `input`、`config` 以及已声明依赖的 `nodes.<dependency>`；Graph 输出可访问全部逻辑节点。缺少引用时抛错，除非提供 `default`。编译器校验结构；动态输入输出形状仍由实际 Node handler 和应用校验。不执行任意 JavaScript，也不会根据 Schema 自动生成业务实现。

对于返回 NodeResult 的操作，可以设置 `"require": { "path": "status", "equals": "success" }`；交付回执则检查 `"accepted"`。校验在节点完成后、下游启动前执行。失败会停止后续调度；已开始的并行操作会等待结束，外部效果不会自动回滚。如果需要模型观察工具失败，可以有意省略工具节点的成功要求，将实际结果交给 OBSERVE。

### Subgraph

```json
{
  "id": "prepare",
  "kind": "subgraph",
  "graph": "normalize",
  "dependsOn": [],
  "input": { "$ref": "input" }
}
```

`normalize` 是 `graphs` 中另一张图，拥有自己的输入、节点和投影输出。父图通过 `nodes.prepare` 读取结果。编译器将它展开到同一张 DAG，叶子 ID 如 `prepare/text`。独立节点保留并行能力，父级依赖约束整个子图。重复引用会创建独立叶子 ID 和数据作用域。必须存在 `main`；其他图既可作为 Subgraph 引用，也可由 Loop 调度。

## 3. Loop 控制 Graph

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

这是 `loop` 字段的示例，需要另行定义引用的 Graph。入口步骤必须执行 `main`。执行顺序固定：

1. 使用 `input` 和 `config` 计算初始 `state`，结果必须为对象。
2. 可选 `while` 条件为 false 时，在执行 Graph 前结束，支持零次循环。
3. 从 `input`、`state`、`config` 绑定步骤输入，执行对应 Graph。
4. 用旧状态与投影后的 `result` 计算全部 `assign` 字段，一次性合并更新状态。
5. 按顺序检查更新后的状态是否命中 transition。每条只能有 `next` 或 `end` 之一，最后一条必须是无条件分支。
6. `end` 时返回 `output`，未设置则返回最终状态。输出可引用 `termination.reason`。尚未执行 Graph 时 `result` 为 null。

条件必须返回布尔值。`maxIterations` 统计外层 Graph 执行次数，重复阶段也计数；Subgraph 叶子已展开到同一张 DAG，不额外计次。超限抛错，不冒充完成。业务动作次数在状态中单独计数，墙钟超时通过宿主取消信号限制。

## 4. 表达式

普通对象和数组递归绑定字段；保留以下表达式形式：

| 形式 | 语义 |
| --- | --- |
| `{"$ref":"state.count"}` | 点分隔的自有属性路径，支持数字数组下标 |
| `{"$ref":"input.optional","default":[]}` | 仅缺失时使用默认值，null 不视为缺失 |
| `{"$literal":{"$ref":"literal text"}}` | 保留与表达式相似的原始数据 |
| `{"$op":"add","args":[1,2]}` | 有类型检查的操作，不隐式转换数字 |
| `{"$map":{"items":{"$ref":"input.items"},"value":{"$ref":"item.text"}}}` | 使用局部 `item`、`index` 映射数组 |

二元操作：`eq`、`ne`（结构相等）、`lt`、`lte`、`gt`、`gte`、`add`、`subtract`、`and`、`or`、`at`、`append`、`concat`（数组）、`merge`（对象）。一元操作：`not`、`length`（字符串/数组）、`first`、`dropFirst`、`isEmpty`（数组）。布尔操作短路求值。错误类型、越界下标和非有限数值报错。

## 5. Worker 注册、工具与权限

`deployment.workers` 的每项为 `{id,use,services?}`。`use` 从宿主已提供的 WorkerDefinition 注册表中选择定义；`id` 是 Runtime 实例 ID，不是 Worker 类型。省略列表时按注册表键名注册全部定义。`services` 可选择宿主授权的 RuntimeServices 配置。不会动态导入模块，也不假设内置工厂名称。

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

上面是接线片段，工厂、工具和资源由宿主提供。JSON 中的 `{"id":"files","use":"interaction","services":"readOnly"}` 会将 Interaction Worker 注册为 `files`。它不是内置 FileWorker。`read_text` 必须真实实现并注册，通过 Sandbox 文件接口落实工作目录和读取权限。

`deployment.bindings` 是 Graph ID → 展开叶子 ID → Worker 实例 ID，例如 `{"main":{"prepare/text":"custom"}}`。省略绑定时按能力路由。未知引用、不存在的叶子和不兼容能力在执行前报错；注册失败会关闭已注册资源。

凭证、数据库客户端和授权上限由宿主管理。只向当前用户开放可选择的 Worker 与资源配置。`requiresApproval`、`effects` 仍然是元数据：可信控制器和执行工具必须在产生效果前核验实际参数对应的审批。Sandbox 为协作式检查，不会拦截自定义 JavaScript 中任意 SDK、fetch 或文件系统调用。[详细工具教程](handbook/tools.md)。

## 6. 公开 API 与执行边界

- `compileAgent(unknown)` 返回不可变的 `definition`、展开后的 `graphs`、生成器 `plan` 和 `run(runtime,input,options)`。编译产物是可执行对象，不是 TypeScript 源文件；编译不会创建 Worker 或执行 IO。
- `await createAgent(unknown, options)` 编译配置并注册 JSON 选择的宿主 Worker，返回 `compiled`、`runtime`、`run(input,options)`、`close()`。
- 两个函数均从 `@codesoul-co/ditto/runtime` 和主包导出；`AgentDefinition` 等公开类型支持 TypeScript 编写配置。JSON 文件由应用显式加载：`JSON.parse(await readFile(...))`。
- `compiled.run` 预检全部声明图和绑定，包括尚未选择的分支；动态参数由 handler 校验。直接将 `compiled.plan` 交给 `runtime.loop` 会跳过编译器预检，推荐使用 `compiled.run`。
- `agent.run` 接受图并发、取消信号、`onGraph` 事件，部署绑定保持固定。`compiled.run` 可复用已注册的本地/远程 Worker 和执行绑定。宿主创建的 Runtime 由宿主关闭；工厂创建的 Runtime 用 `agent.close()` 关闭。
- 初版编译器使用一个生成器 Loop，拒绝 `checkpoint` / `stateCheckpoint`，不保存执行栈。应用 Memory 可以实现完整会话示例中的已完成轮次重放；运行中状态机持久恢复请使用[深入状态式 Loop 教程](handbook/graph-loop.md)与[检查点](worker-api/checkpoints.zh-CN.md)。

## 7. 更详细的搭建模式

完整的 [npm 三类场景验收](../examples/json-agent/npm-scenarios/README.zh-CN.md)涵盖五 Worker 大图、独立第三方 Node/Worker 包、main 路由与多节点 Subgraph。运行 `npm run check:package:json-agents -- --keep` 可检查实际 tarball 安装、严格类型、真实工具调用、持久化和失败路径。

标准入口使用 JSON。深入集成时继续阅读[代码式 Graph/Loop](handbook/graph-loop.md)、[扩展 Node/Worker](handbook/extensions.md)、[模型](handbook/models.md)、[Memory](handbook/memory.md)、[部署](handbook/deployment.md)。新增 Node 契约和 handler 仍由可信扩展包实现，注册后即可在 JSON 中通过 `type` 使用。
