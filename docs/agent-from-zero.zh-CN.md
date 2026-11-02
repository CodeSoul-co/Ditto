# 从零运行完整 Agent，再部署远端 Worker

[English](agent-from-zero.md) · [配置协议](agent-json.zh-CN.md)

这条路线使用已发布的 `@codesoul-co/ditto@0.1.4` 与 `@codesoul-co/ditto-retrieval@0.1.0`。先在单进程运行一个由 JSON 定义、包含五个 Worker 的 Agent，再把相同 Graph/Loop 的 Node 调用改为 HTTP。模型、工具、Redis 和文件 SQLite 都参与实际执行；示例业务代码属于你的应用，不是 npm Core 的隐藏接口。

## 1. 创建独立 npm 项目

准备 Node.js 24+、npm 11+、支持工具调用的模型服务，以及可访问的 Redis。下面下载的是应用示例，`npm install` 安装已发布包，不需要编译 Ditto 源码。

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

主要文件与职责：

```text
agent.json                      Graph / Node / Loop / Worker 绑定
ditto.yaml                      Runtime 默认值、Context 策略和缓存参数
.env                            模型凭证、网络许可、Redis URL
input.json                      一次业务请求，不放凭证
task/guide.json                  检索知识源
examples/json-agent/npm-scenarios/
  cli.mjs                       读取 JSON，调用本地宿主
  host.ts                       创建资源与 Worker，运行和释放 Agent
  remote.mjs                    HTTP Worker 服务端与控制端
examples/_shared/tools/storage/ Redis 与 SQLite 应用适配器
```

## 2. 准备模型与 Redis

编辑 `.env` 中的占位值：

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

`BASE_URL` 填 API 根地址；网络许可填对应 origin，不带 `/v1`。示例需要模型返回原生工具调用，只有普通文本输出的模型不能完成这条流程。其他 Provider kind 见[模型配置](worker-api/providers.zh-CN.md)。

连接已有 Redis，或在安装 Redis 的机器上另开终端运行：

```sh
redis-server --bind 127.0.0.1 --port 6379
```

此示例的 Memory 使用 Node 内置 `node:sqlite`，文件自动创建为 `task/memory.sqlite`，不用另外启动 SQL 服务。切换 PostgreSQL/MySQL 时由应用提供实现 `MemoryStore` 的适配器与连接池，不是修改一个 YAML 字段就自动切换。

`ditto.yaml` 会在创建 Runtime services 时自动读取；`.env` 通过启动命令的 `--env-file` 加载。`host.ts` 为所有 Worker 共享这份启动配置。它读取 YAML 中的 Context 缓存参数并传给 Redis 适配器，文件本身不会创建数据库连接。

## 3. 五个 Worker 的真实资源接线

[host.ts](../examples/json-agent/npm-scenarios/host.ts) 的 `openScenarioResources()` 完成以下工作：

| Worker | 实际资源 | 接入口 |
| --- | --- | --- |
| Context | 已连接的 Redis 客户端、scope 缓存、TTL | `createContextWorker({ redis: { client, ...cache } })` |
| Memory | 持久化 SQLite `MemoryStore` | `createMemoryWorker({ store })` |
| Infer | 环境配置生成的 HTTP Provider；示例包装调用以记录次数 | `createInferWorker({ providers })` |
| Interaction | `count_characters` 工具实现、写答案文件的 OutputSink | `createInteractionWorker({ tools, output })` |
| Retrieval | 从 `task/guide.json` 读取并匹配的关键词 Provider | `createRetrievalWorker({ providers: registry })` |

这里的检索是可验证的文件关键词搜索，不是向量数据库。以后换向量服务时替换 Provider；新增 MCP、网页搜索或命令工具也在宿主接线处完成。完整存储实现见 [workers.ts](../examples/_shared/tools/storage/workers.ts)、[redis-context.ts](../examples/_shared/tools/storage/redis-context.ts)、[sqlite-memory.ts](../examples/_shared/tools/storage/sqlite-memory.ts)。这些适配器是可复制的应用代码，并非 npm 包导出。

工具有两份不同职责的数据：`agent.json.config.actions` 是发给模型的工具描述；宿主 `tools` 中的 `validate` / `execute` 才是真实实现。两边名称和输入契约必须一致。宿主提供 `count-only` 权限配置，只允许调用 `count_characters`；JSON 中的 `deployment.workers[].services` 选择这个已授权配置，不能自行授予权限。答案文件由宿主指定目录的 OutputSink 写出。

## 4. 加载 JSON，执行并核对产物

[agent.json](../examples/json-agent/npm-scenarios/single/agent.json) 定义一个 13 节点的 main Graph 和执行它的外层 Loop：

```text
Memory 读取 + Retrieval 检索
  → Context 加载 / 选择
  → Infer 产生工具请求
  → Interaction 执行 / 观察
  → Context 更新 / 选择
  → Infer 生成答案
  → Memory 保存 / 读取核对
  → Interaction 输出文件
```

运行：

```sh
node --env-file=.env examples/json-agent/npm-scenarios/cli.mjs agent.json input.json task
cat task/answers/demo-1.md
```

期望答案为 `3`（`A😀B` 的 Unicode 码点数），终端结果包含 `answer`、`characters`、审计 token 与调用轨迹。SQLite 保存结果，Redis 保存本轮 Context。每个新任务应使用新的 `memoryKey`、`deliveryId` 和 scope；这个单图示例不会自动对重复任务去重。

CLI 的核心流程是 `readFile → JSON.parse → runScenario → createAgent → agent.run → agent.close`。只有 `agent.json` 决定 Graph/Loop；宿主不再用代码重写节点依赖。`deployment.workers[].use` 选择宿主注册表项，`id` 是实例 ID，`bindings` 把节点绑定到该 ID。

这条五 Worker 路线不需要第三方扩展。更复杂的 main 路由、Subgraph 和恢复分支见 [routed/agent.json](../examples/json-agent/npm-scenarios/routed/agent.json)；它额外使用示例 `text` Worker，需要先构建并安装本地扩展包，步骤见 [npm 场景说明](../examples/json-agent/npm-scenarios/README.zh-CN.md)。扩展包没有发布到 npm。

## 5. 接入长期运行的应用

CLI 每次运行负责一次启动和关闭。HTTP 应用应在启动时打开资源、创建 Agent，然后复用它处理请求：

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
    // 在应用请求处理器中重复调用；身份与 scope 由可信控制器确定。
    console.log(await agent.run({ ...request, model: resources.model }));
  } finally { await agent.close(); } // 服务关闭时：先停接请求，再排空 Agent。
} finally { await resources.close(); } // 最后关闭注入的 Redis / SQLite。
```

复用的是 Worker 实现与连接；请求输入、Loop 状态和结果仍独立。同一会话并发写入需要业务串行化/CAS，不能只依赖 Graph 并发。示例 trace 是演示记录，长期服务应替换为有容量限制的日志/指标接收端。

## 6. 同一 JSON 迁移到 HTTP Worker

当前 npm 已有 `createHttpTransport()`、`createWorkerHttpHandler()`、`registerRemote()`。这一步不改 `agent.json`，先把五个 Worker 一起放到服务端，控制端只保留 Graph/Loop。

```text
控制端：agent.json → compileAgent → Runtime + registerRemote
                                  ↓ HTTP(S) Node 调用
Worker 服务端：HTTP handler → 本地 Worker → 模型 / Redis / SQLite / 工具
```

先在同一台机器上验证两个进程。生成共享 token，复制到服务端 `.env` 和控制端独立的 `controller.env`：

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

```dotenv
DITTO_TRANSPORT_HTTP_WORKER_TOKEN=PASTE_THE_SAME_GENERATED_TOKEN
```

服务端保留模型与 Redis 配置，控制端的 `controller.env` 只需要通信 token。不要把密钥写进 `agent.json` 或部署清单。

终端 A 启动 Worker 服务并生成地址清单：

```sh
node --env-file=.env examples/json-agent/npm-scenarios/remote.mjs serve task deployment.json
```

终端 B 运行原来的 Agent 配置。使用新的任务 ID 或独立的服务端任务目录，避免复用上一次写入的任务键：

```sh
node --env-file=controller.env examples/json-agent/npm-scenarios/remote.mjs run agent.json input.json deployment.json
```

`deployment.json` 是此应用示例的连接清单，包含 URL、非秘密模型标识、Worker 地址与能力。它不是新增的 Ditto JSON 配置协议。控制端加载清单，创建 transport，执行 `runtime.registerRemote()`，再调用 `compileAgent(definition).run(runtime, input)`。它不创建本地 Worker、不需要模型 Key 或数据库客户端。

服务端使用相同资源工厂，按固定实例 ID 注册五个 Worker；Interaction 的工具许可在服务端固定为 `count-only`。远端路径不会执行 JSON 的本地 Worker 工厂注册，也不会把 `serviceProfiles` 作为权限传给服务端。改变执行端授权需要修改执行端宿主配置。

真正跨机器时，在服务端设置 `DITTO_EXAMPLE_WORKER_BIND`（默认 `127.0.0.1`）、`DITTO_EXAMPLE_WORKER_PORT`（默认 `8080`）和 `DITTO_EXAMPLE_WORKER_URL=https://worker.example/ditto/invoke`，配置受控 TLS 入口，将生成的清单通过可信部署渠道复制给控制端。重启后 processId 会变化，需要重新发布清单。不要把 loopback URL 直接复制到另一台机器后期望自动连通。

答案文件与 SQLite 留在 Worker 服务端的 `task` 目录；控制端得到 JSON 结果。SQLite 不是跨机共享数据库。拆成多个 Worker 服务时，每组只初始化需要的资源，为每个服务创建 transport，再注册其实际 Worker 地址；保持 JSON 绑定中的 Worker ID 稳定即可。Core 不提供自动发现、代码分发或远端进程启动。

## 7. 通信边界与验收

| 位置 | 当前通信方式 | 宿主责任 |
| --- | --- | --- |
| 同进程 | 直接调用已注册 Worker | 创建和关闭资源 |
| 同机不同进程 | `createIpcTransport` + `serveWorkerIpc`，也可用 HTTP | 启动子进程、登记地址、关闭 IPC；见 [placement.ts](worker-api/examples/runtime/placement.ts) |
| 跨机器 | HTTP(S) transport + Worker handler | 部署服务、token/TLS、地址清单和网络连通 |

Graph 与 Loop 状态留在控制端，传输的是 Node 输入/输出。HTTP token 授权服务端公开能力，不是租户 ACL；业务入口仍需控制器认证。网络超时不保证远端任务停止，不自动重试，也不提供 exactly-once；涉及写入的业务要自行定义幂等键。跨机事件与大对象存储另见[Worker 通信](worker-communication.zh-CN.md)。

仓库开发验收命令（下载的消费者项目不包含这些开发脚本）：

```sh
node --env-file=.env scripts/check-json-agent-package.ts --registry --keep
```

它在仓库外安装公开 npm 包，验证本地五 Worker、大图工具调用、无需扩展的 CLI、相同 JSON 的真实 HTTP 调用与错误 token，以及第三方 Worker、Subgraph 路由、跨进程 Redis 过期后从 SQLite 恢复、预算、权限与存储故障。HTTP 验收使用本机两个进程和真实 socket，不等于验证你的生产 TLS、跨机网络或 PostgreSQL/MySQL 部署。


配置加载完成后，独立图执行、持久恢复、补充消息边界及画布编辑器工具见[执行与恢复指南](agent-execution.zh-CN.md)。
