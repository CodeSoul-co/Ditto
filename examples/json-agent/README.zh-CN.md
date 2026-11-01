# 配置文件构建 Agent 示例

[English](README.md) · **简体中文** · [配置参考](../../docs/agent-json.zh-CN.md)

从 `agent.json` 开始。宿主仅通过 npm 公开 API 提供 Worker 实现和资源；Graph、Subgraph、Loop 控制、普通参数与注册/绑定引用都放在 JSON 中。

| 示例 | 配置 | 宿主 | 范围 |
| --- | --- | --- | --- |
| 标准模板 | [agent_example.json](../../agent_example.json) | [quickstart.ts](quickstart.ts)（传入配置路径） | main + Subgraph，多节点依赖、Loop 状态与预算、Worker 绑定 |
| 单张 main Graph | [agent.json](agent.json) | [quickstart.ts](quickstart.ts) | LOAD → SELECT 两个节点的本地 API 入门，不涉及模型或持久化 |
| main 路由 + Subgraph + Loop | [router/agent.json](router/agent.json) | [router.ts](router.ts) | 自定义类型化 Node/Worker、工具注册、受限服务、分支和重复执行 |
| 完整会话 Agent | [conversation/agent.json](conversation/agent.json) | [conversation.ts](conversation.ts) | 真实模型、带 scope 的 Redis Context、文件 SQLite Memory、最近轮次重放和答案文件 |
| npm 三类场景验收 | [配置与运行说明](npm-scenarios/README.zh-CN.md) | [host.ts](npm-scenarios/host.ts) | 五 Worker 的 13 节点大图、独立第三方扩展包、main 路由与多个多节点 Subgraph |

## 从标准模板开始

在源码仓库中复制并运行：

```sh
cp agent_example.json agent.json
node examples/json-agent/quickstart.ts 'Hello Ditto' agent.json
```

也可以用 `npm run example:json:template` 直接运行原始模板。独立 npm 项目从 `node_modules/@codesoul-co/ditto/agent_example.json` 复制，宿主写法见[配置教程](../../docs/agent-json.zh-CN.md)。复制后保留模板作为参考，在自己的 `agent.json` 中编辑。

模板执行 `main → load-context Subgraph（LOAD）→ SELECT`，外层 Loop 默认执行一轮；将 `config.repetitions` 改为 2 就会执行两轮。`loop.maxIterations` 是执行预算，`deployment` 选择宿主的 Context Worker。输出为 `Hello Ditto`。这是不依赖模型的编排模板，业务工具、模型与持久化按下方完整示例接入。

## 运行本地编译示例

```sh
npm ci
node examples/json-agent/quickstart.ts
node examples/json-agent/router.ts 'A😀' count
node examples/json-agent/router.ts ' Hello ' echo
```

预期分别输出 `Hello Ditto`、`[2,2]`、`["Hello"]`。路由示例的 main Graph 调用规范化 Subgraph，再执行自定义路由 Node；Loop 选择计数或原文输出，计数 Graph 使用 TOOL → OBSERVE 两个节点，重复两次。未选中的分支不执行。Interaction Worker 注册真实的 Unicode 计数工具，宿主授权配置仅允许该工具。这些是确定性的编译/适配器示例，不作为模型端到端验收。

## 运行完整 Agent

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
cp examples/package-basics/.env.example .env
# 配置真实供应商、模型、网络 origin 和 Redis。
redis-server --bind 127.0.0.1 --port 6379
```

另一个终端执行：

```sh
node --env-file=.env examples/json-agent/conversation.ts --session alice --turn turn-1 --prompt '记住我的项目代号 orchid-42。'
node --env-file=.env examples/json-agent/conversation.ts --session alice --turn turn-2 --prompt '我的项目代号是什么？'
```

`main` 是由历史 Subgraph 和应用校验 Node 支撑的小型路由图。JSON Loop 选择生成新答案或重放，再选择写入/更新和交付。每轮从 SQLite 历史重建 Context，使用 Redis scope 加载、选择推理上下文，再更新工作集。Redis 故障明确失败，不降级为内存。答案保存在 `.examples-json-agent-tasks/alice/answers/`，`memory.sqlite` 支持跨进程会话历史。

宿主校验 session/turn/prompt，持有凭证和连接，定义 PREPARE/FINALIZE 契约。这些 Node 负责业务输入和结果语义，不调度 Graph，也不隐藏模型调用。全部阶段、分支和绑定均在 JSON 中。模型必须返回非空文本，Memory 保存成功后才交付。最近 turn 的相同输入直接重新交付，不再次调用模型；相同 ID 换输入会失败。同一会话串行执行。示例保留五轮历史和最近轮次重放，不包含任意执行中恢复或多租户认证。

## npm 消费者与验收

独立 ESM 项目安装 `@codesoul-co/ditto`、`redis@6.2.1`，复制 `examples/json-agent/`、`examples/_shared/tools/package-basics.ts` 及[基础示例指南](../package-basics/README.zh-CN.md)列出的 storage 文件，保持相对目录。无需源码别名或内部导入。导入宿主模块不会启动任务。

```sh
npm run check
npm run check:package:basics
npm run check:package:basics:live
npm run check:package:json-agents -- --keep
```

包验收在仓库外安装构建 tarball，运行路由的两条分支、严格类型和静默导入检查，并执行 README 代码。live 模式还分别运行代码式和 JSON 会话，使用真实供应商、Redis、SQLite，检查跨进程历史、Redis 过期/故障、输入变更拒绝、重放和交付产物。不会用单元测试替代真实验收。

需要模型自主选动作时，将路由输入替换为推理结果，并在同一个外层 Loop 中定义工具 Graph 与 OBSERVE 反馈。工具与审批仍由宿主负责，详见 [JSON 参考](../../docs/agent-json.zh-CN.md)和[深入 ReAct 示例](../patterns/react/README.zh-CN.md)。
