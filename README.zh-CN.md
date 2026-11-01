<p align="center">
  <img src="./logo_project.png" alt="Ditto logo" width="280" />
</p>

<h1 align="center">Ditto</h1>

<p align="center">
  面向可组合 Agent 系统的轻量 Node-native Runtime。<br />
  扩容 Worker，无需改变 Graph 与 Node Contract。
</p>

<p align="center">
  <a href="https://github.com/erwinmsmith/Ditto/blob/main/README.md">English</a> | <strong>简体中文</strong>
</p>

> 权威定义见[节点体系与 API Contract](https://github.com/erwinmsmith/Ditto/blob/main/docs/13-node-api-contract.zh-CN.md)，其中包含最终节点树、语义边界、固定公共类型，以及所有公共 Node 的输入输出契约。

**[从零搭建完整 Agent](docs/agent-from-zero.zh-CN.md)** · [配置协议](docs/agent-json.zh-CN.md) · [开发者搭建手册](docs/handbook/index.md)

## 安装与使用

要求 Node.js 24+、npm 11+。包提供 ESM JavaScript 和 TypeScript 声明。下方配置文件构建 API 与模板需要 `@codesoul-co/ditto@0.1.4` 或更高版本。

```sh
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto
```

推荐从仓库根目录的标准模板 [agent_example.json](agent_example.json) 开始。模板包含 main、Subgraph、Loop 和 Worker 注册绑定，普通参数在 `config` 中调整。安装 npm 包后复制：

```sh
cp node_modules/@codesoul-co/ditto/agent_example.json agent.json
```

在源码仓库中执行 `cp agent_example.json agent.json`。完整配置如下：外层 Loop 执行 main，main 引用 load-context Subgraph，再执行 SELECT；`deployment` 注册并绑定 Worker。

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

默认执行一轮；将 `config.repetitions` 改成 `2` 会执行两轮，`loop.maxIterations` 是总执行预算。另存以下运行参数为 `ditto.yaml`：

```yaml
runtime:
  graphConcurrency: 4
workers:
  context:
    policy:
      maxItems: 256
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

| 配置 | 职责 |
| --- | --- |
| `agent.json` | main、Subgraph、Node 依赖、Loop 分支/停止条件、业务参数和 Worker 绑定 |
| `ditto.yaml` | Runtime 与 Worker 的行为默认值，创建 Agent / Runtime 时自动读取 |
| `.env` | 凭证、地址、模型选择和部署权限；需要时用 `node --env-file=.env app.mjs` 加载 |

创建 `createAgent()` / `createDitto()` 时，默认从当前工作目录（`process.cwd()`）读取 `ditto.yaml`，并结合已有的 `process.env` 生成 Runtime 配置；不需要手动调用加载器，也不会向上搜索目录。默认文件不存在时使用环境变量和内置默认值；格式错误、非法参数或无法读取时直接报错。每个 Runtime 启动时读取一次，不在每次 Node 调用时重读。传入 `config` 会完全跳过自动加载；自定义路径可使用 `config: loadRuntimeConfigFile("path/to/ditto.yaml")`，仅需内置默认值可使用 `config: loadRuntimeConfig({})`。`.env` 文件仍由应用或 `node --env-file=.env` 加载，导入 npm 包和 `compileAgent()` 不读取文件。

优先级按具体参数决定，两个文件不会整体合并：

| 参数 | 生效顺序（左侧优先） |
| --- | --- |
| Runtime 配置来源 | 显式 `createAgent(..., { config })` / `createDitto({ config })` → 自动读取 `./ditto.yaml` 与进程环境变量 → 各字段内置默认值 |
| Loop 执行预算 | `agent.json.loop.maxIterations`；配置 `loop` 时此项必填。YAML 的 `runtime.loopMaxIterations` 只为未指定预算的代码式 Loop 提供默认值；未配置 `loop` 的 Agent 只执行一次 main |
| Graph 并发 | `agent.run(input, { concurrency })` → YAML `runtime.graphConcurrency` → 内置默认值 `Infinity` |
| Memory 查询数量 | Node 输入 `limit`（可在 `agent.json` 中指定）→ Worker 工厂 `defaults.queryLimit` → YAML `workers.memory.queryLimit` → 内置默认值 `100` |
| 业务参数 | `agent.json.config` 仅供 `$ref: "config.…"` 引用，不覆盖 YAML 或宿主 Runtime `config` |
| Context 策略 | Worker 工厂 `policy` 的显式字段 → YAML `workers.context.policy` → 内置默认值；`createContextWorker()` 自动使用 Runtime 策略 |

环境变量提供凭证、地址、模型选择与部署权限，YAML 提供行为默认值，两者按字段分工，并无通用的“环境变量覆盖 JSON/YAML”规则。其他 Node 参数以各自契约为准；Node 输入不能借由默认值覆盖规则授予工具权限。数据库、工具与服务配置仍由宿主创建并注入。

### 从零运行完整 Agent：资源、JSON 与部署

完整路线见[从零运行完整 Agent，再部署远端 Worker](docs/agent-from-zero.zh-CN.md)。下面使用五个 Worker、真实模型、Redis、SQLite 和工具执行；示例主图有 13 个节点，编排完全在 `agent.json` 中。

| Worker | 资源在哪里接入 |
| --- | --- |
| Context | 应用连接 Redis，传给 `createContextWorker({ redis: { client } })` |
| Memory | 应用提供 SQLite / 其他数据库的 `MemoryStore`，传给 `createMemoryWorker({ store })` |
| Infer | `.env` 提供模型地址、Key、模型名与网络许可；Runtime 创建 HTTP Provider |
| Interaction | 宿主注册工具实现与 OutputSink，并提供允许调用的工具权限配置 |
| Retrieval | 安装独立检索包，注入文件 / 向量库等检索 Provider |

从空目录下载应用示例并安装已发布 npm 包：

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

填写 `.env` 中的真实模型凭证、网络 origin 与 Redis URL，并启动 Redis。SQLite 文件由应用自动创建；这条五 Worker 路线不需要第三方扩展。随后运行：

```sh
node --env-file=.env examples/json-agent/npm-scenarios/cli.mjs agent.json input.json task
cat task/answers/demo-1.md
```

预期输出 `3`，同时产生真实工具调用、Redis Context、`task/memory.sqlite` 和答案文件。每个新任务使用新的业务 ID。[host.ts](examples/json-agent/npm-scenarios/host.ts) 的 `openScenarioResources()` 负责一次性打开资源和构建 Worker，CLI 负责读取 JSON，再调用 `createAgent()` / `agent.run()`；资源适配器是应用源码，不是 npm Core 的内置数据库连接。

接入长期服务时，启动阶段创建资源和 Agent，请求阶段复用 `agent.run(input)`；停服时先排空 Agent，再关闭 Redis/数据库。JSON 通过 `deployment.workers[].use` 选择宿主实现，通过 `bindings` 选择实例；它不会创建工具实现或自行授予权限。

**跨机部署沿用同一份 JSON。** [remote.mjs](examples/json-agent/npm-scenarios/remote.mjs) 提供可运行的 HTTP 服务端/控制端：服务端创建资源并注册五个 Worker；控制端使用 `compileAgent()`、`createHttpTransport()` 和 `registerRemote()`，再执行编译后的计划。Graph/Loop 留在控制端，Node 调用跨 HTTP(S)，数据库和模型 Key 留在执行端。同机多进程另有 IPC。token、TLS、地址清单、停止流程和通信限制见[完整部署步骤](docs/agent-from-zero.zh-CN.md#6-同一-json-迁移到-http-worker)；`agent.json` 目前不负责自动部署或发现远端服务。

第一张 Graph 不需要模型、Redis 或凭证。完整 Agent 使用真实模型、Redis Context 和数据库 Memory，详见[非常详细的 npm 包使用教程](https://github.com/erwinmsmith/Ditto/blob/main/docs/package-guide.zh-CN.md)：从空项目安装、TypeScript、API 返回值、工具注册、Loop 组合，到持久化、跨进程恢复、产物输出和故障排查。

[四个可运行入门示例](https://github.com/erwinmsmith/Ditto/tree/main/examples/package-basics)分别展示 Context、工具、可选检索和持久化多轮 Agent。教程提供将应用适配器复制到独立 npm 项目的具体命令；示例业务函数不作为包 API 导出。

需要检索时单独安装：

```sh
npm install @codesoul-co/ditto-retrieval
```

从 `@codesoul-co/ditto-retrieval` 导入检索 Worker；`@codesoul-co/ditto/runtime`、`@codesoul-co/ditto/worker/memory` 等是主包的公开子入口。不要导入包内部的 `src` 或 `dist` 路径。

标准搭建方式是通过配置文件构建 Agent，当前使用 JSON 格式：必需的 `main`、可选 Subgraph、外层 Loop、Worker 注册引用与绑定都由 `agent.json` 管理。宿主提供真实实现、凭证与权限。参见 [配置文件教程](docs/agent-json.zh-CN.md)和 [配置文件示例](examples/json-agent/README.zh-CN.md)。以下代码式编排与 Provider 接线是深入用法。

## 架构定位

Ditto 将系统拆分为四个概念：

- **Node**：最小的可路由语义操作；
- **Worker**：实现、资源、部署与扩容边界；
- **Execution Graph**：与执行位置无关的 Node 组合；
- **Runtime**：负责调度、路由、通信与执行。

更换模型、数据库、工具 Provider、部署位置或副本数不会产生新的 Node Type。Runtime 内部以 `invoke` 表示请求/响应，以 `emit` 表示异步事件；二者都不是 Interaction Node。

## 最终能力域

- `INFER.REASONING.*`：显式推理组织能力，包括 `TRAJECTORY`、`REFLECT`、`DELIBERATE`、`SAMPLE`；
- `INFER.CACHE.*`：推理缓存的 `LOOKUP`、`WRITE`、`INVALIDATE`；
- `CONTEXT.*`：当前 invocation/turn 的 working set，包括任务知识 RAG 与本轮激活的 Skill；
- `MEMORY.*`：长期记忆存储与搜索，提供 GET / QUERY / SEARCH / WRITE / UPDATE / DELETE；
- `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP`：对外动作；
- `INTERACTION.OBSERVE` / `INTERACTION.OUTPUT`：标准化观察与最终输出。

`INFER/PROVIDERS` 是实现目录，不是 Node。`INFER/REASONING` 同样是源码目录，不存在 `REASONING` Node。工具通过 `createInteractionWorker({ tools, mcp, output })` 注入；具体工具名、Linux 命令与网页搜索 Provider 都不产生额外 Node Type。`createReadOnlyCommandTools()` 提供 14 个可选且有界的搜索、读取、文本处理、元数据、磁盘占用和工作区定位命令；`createWebSearchTool()` 接收应用注入的 Provider，`createBraveWebSearchProvider()` 是首个基于原生 fetch 的适配器。Core 不会自动注册或授权这些辅助函数返回的工具。

RETRIEVAL 是可选的独立检索执行 Worker，仅提供 `RETRIEVAL.SEARCH`。按需从 `@codesoul-co/ditto-retrieval` 导入并注册；Core 默认不加载它。普通 MEMORY/CONTEXT 的直接 Provider 接入不变。见 [RETRIEVAL API](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/retrieval.zh-CN.md)。

## Runtime 预定义流程

四类公开组合直接位于 `src/runtime/graph.ts`，并由 `@codesoul-co/ditto/runtime` 导出：

```text
runRagFlow          CONTEXT.SELECT (rag strategy)
runSkillFlow        CONTEXT.LOAD -> CONTEXT.UPDATE (when context is supplied)
runToolCallFlow      INTERACTION.ACT.TOOL   -> INTERACTION.OBSERVE -> CONTEXT.UPDATE
runMcpFlow           INTERACTION.ACT.MCP    -> INTERACTION.OBSERVE -> CONTEXT.UPDATE (invoke)
```

这些 Runtime 函数使用显式 Context。RAG 是 SELECT 的内部策略，Skill 内容由应用解析后经 LOAD/UPDATE 加入工作集。缓存调用、Redis 接入和详细示例见 [CONTEXT API](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/context.zh-CN.md)。

```ts
import { runRagFlow, runToolCallFlow } from "@codesoul-co/ditto/runtime";

const retrieved = await runRagFlow(runtime, {
  context: { items: [] },
  query: "查找相关 API 定义",
  corpus: { uri: "urn:contracts" }, // Resolved by the configured ragStrategy.
});

const toolResult = await runToolCallFlow(runtime, {
  context: retrieved.context,
  call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } },
});
```

## Graph 与 Worker

Graph 只包含语义 Node Type 与数据绑定，不包含 Worker ID 或网络地址：

```ts
import { randomUUID } from "node:crypto";
import { graph, type Message } from "@codesoul-co/ditto";

const review = graph<Message>("review")
  .node("memories", "MEMORY.GET", [], () => ({
    keys: ["review-policy"],
  }))
  .node("context", "CONTEXT.LOAD", ["memories"], (query, { memories }) => {
    if (memories.status !== "success" || !memories.output) throw new Error("Memory read failed");
    return { sources: [query, ...memories.output.map(memory => ({
      id: memory.id, content: typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content),
    }))] };
  })
  .node("reason", "INFER.REASONING.TRAJECTORY", ["context"], (_query, { context }) => ({
    messages: [{ role: _query.role, content: typeof _query.content === "string"
      ? _query.content : JSON.stringify(_query.content) }],
    context: context.items.map(item => ({ id: item.id, content: item.content })),
    model: { model: "your-model-name" },
    strategy: { name: "cot" },
  }))
  .node("output", "INTERACTION.OUTPUT", ["reason"], (_query, { reason }) => {
    if (reason.status !== "success" || reason.output?.status !== "completed") {
      throw new Error(reason.error?.message ?? "Trajectory incomplete");
    }
    return { deliveryId: randomUUID(), message: { role: reason.output.result.role,
      content: typeof reason.output.result.content === "string"
        ? reason.output.result.content : JSON.stringify(reason.output.result.content) } };
  });
```

注册更多 Worker 副本即可扩容，不需要改变 Graph。同一套契约可用于单进程、多 Worker、多进程或自定义远程传输。

详细 INFER 接入与七个叶子接口见 [Worker API](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/infer.zh-CN.md)。

按 Graph → Loop → Worker 定义 Agent，完整示例见 [graph-loop-worker.ts](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/examples/graph-loop-worker.ts)，运行 `npm run example:agent`。工具与 MCP 接入见 [Interaction API](https://github.com/erwinmsmith/Ditto/blob/main/docs/interaction-runtime.zh-CN.md#graphloop-与-worker-使用入口)。

## 仓库结构

```text
src/
├── contracts/                    # 固定公共类型与开放式 NodeContractMap
├── runtime/
│   ├── graph.ts                  # DAG 与四类预定义流程
│   ├── runtime.ts                # 路由与生命周期
│   └── communication/            # invoke/emit、传输与 Artifact
└── worker/
    ├── infer/
    │   ├── reasoning/            # 推理叶子实现与节点骨架
    │   ├── cache/                # LOOKUP / WRITE / INVALIDATE
    │   └── providers/            # 统一 Provider 注册和供应商协议
    ├── context/
    ├── memory/
    └── interaction/act/tool/     # Tool Node、注册表与实现目录
```

可选的 SEARCH Worker 位于 `packages/retrieval/`，以独立包 `@codesoul-co/ditto-retrieval` 发布。

Core 的第三方运行时依赖仅有 `yaml` 解析器。重型 RPC、事件总线、MCP SDK、数据库驱动与模型 SDK 保持为可选的应用/适配器选择。

## 开发

要求 Node.js 24+、npm 11+。

```bash
npm ci
npm run check
```

安装运行时使用 `npm install @codesoul-co/ditto`；需要可选检索 Worker 时，再安装 `@codesoul-co/ditto-retrieval`。

Runtime 的节点绑定、独立 Sandbox、Loop 和两种部署通信方式详见 [Runtime API](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/runtime.zh-CN.md)；完整代码见 [Runtime 示例](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/examples/runtime/README.zh-CN.md)。

## 文档

- [示例目录：控制流程、基础能力与执行模式](https://github.com/erwinmsmith/Ditto/blob/main/examples/README.zh-CN.md)（入门运行 `npm run example:quickstart`）
- [节点体系与 API Contract](https://github.com/erwinmsmith/Ditto/blob/main/docs/13-node-api-contract.zh-CN.md)
- [架构与扩展边界](https://github.com/erwinmsmith/Ditto/blob/main/docs/architecture.zh-CN.md)
- [开发与 package 集成](https://github.com/erwinmsmith/Ditto/blob/main/docs/getting-started.zh-CN.md)
- [Worker 通信与部署](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-communication.zh-CN.md)
- [Provider、Interaction 与预定义流程](https://github.com/erwinmsmith/Ditto/blob/main/docs/interaction-runtime.zh-CN.md)

具体使用案例、缺陷与架构讨论请提交至 [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues)。

行为参数统一放根目录 [`ditto.yaml`](https://github.com/erwinmsmith/Ditto/blob/main/ditto.yaml)，凭证与部署配置使用 [`.env.example`](https://github.com/erwinmsmith/Ditto/blob/main/.env.example)，Worker 默认共享 Runtime services，也可独立注入。详见 [统一配置 API](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/configuration.zh-CN.md)。运行方式见 [INFER 示例指南](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/examples/guide.zh-CN.md#infer)。

MEMORY 的接入、插件边界、六个节点和配置详见 [MEMORY API](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/memory.zh-CN.md)。

其他公共接口与调用方式：[Worker 组合 / 事件 / Artifact](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/composition.zh-CN.md)、[预定义流程](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/flows.zh-CN.md)、[无需外部服务的入门示例](https://github.com/erwinmsmith/Ditto/blob/main/examples/quickstart.ts)。

`@codesoul-co/ditto@0.1.1` 从根入口提供可移植 JSON checkpoint、隔离状态分支与共享 token 预算。用法、恢复边界和外部资源限制见[检查点与预算契约](https://github.com/erwinmsmith/Ditto/blob/main/docs/worker-api/checkpoints.zh-CN.md)。
