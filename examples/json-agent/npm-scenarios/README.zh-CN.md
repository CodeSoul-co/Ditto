# JSON Agent：npm 场景验收

[English](README.md) · **简体中文** · [JSON 示例](../README.zh-CN.md)

这里验证消费者安装 npm 包后，仅通过公开 API 提供 Worker、工具与资源，由 `agent.json` 定义编排。验收将 Core、Retrieval 和示例第三方扩展分别打成 tarball，在仓库外安装；不发布 registry，不使用源码别名或 npm link。

| 场景 | 配置 | 实际执行 |
| --- | --- | --- |
| 单一 Agent、大 Graph | [single/agent.json](single/agent.json) | main 中 13 个节点，覆盖 Context、Memory、Infer、Interaction、Retrieval；检索、上下文、模型原生工具请求、工具调用、观察、再次推理、持久化和文件交付 |
| 第三方 Node/Worker | [custom/agent.json](custom/agent.json) | 7 个节点；独立扩展包的 NORMALIZE、FORMAT 与 Memory、Context、Interaction 组合 |
| main 路由与功能 Subgraph | [routed/agent.json](routed/agent.json) | main 的 NORMALIZE → ROUTE 返回分支；外层 Loop 选择 work 或 recall；work 展开 research（5 节点）、act（3 节点）、finish（5 节点）；recall 是 4 节点历史读取图 |

第五个 Worker 由 `@codesoul-co/ditto-retrieval` 提供。检索适配器读取消费者的 `guide.json`，工具真实计算 Unicode 码点数；模型调用、Redis Context 和文件 SQLite Memory 均使用真实资源。宿主接线见 [host.ts](host.ts)，第三方实现见 [extension/index.ts](extension/index.ts)。

## 在仓库运行

需要 Node 24+、npm 11+，先安装仓库依赖。使用 [环境变量模板](../../package-basics/.env.example) 配置 `.env` 中的模型、凭证、网络白名单及 Redis URL。启动自己管理的 Redis 后运行：

```sh
npm run check:package:json-agents -- --keep
```

`--keep` 保留日志中打印的独立消费者目录。验收报告在仓库根目录 `.examples-json-agent-package-live-results.json`；独立目录的 `task/results.json`、`task/memory.sqlite` 与 `task/answers/` 保存详细结果和业务产物。凭证只通过环境变量传给进程，不复制 `.env`、不写入配置或报告。

验收检查真实模型产生的工具参数、工具执行次数、最终答案、节点展开路径、分支跳过、JSON Loop 预算；还检查未注册 Worker、未知 Node、错误绑定、工具权限拒绝、SQLite 写入失败和 Redis 不可用。另一个进程在 Redis 过期后从 SQLite 恢复结果，重建 Context 并交付，不重复模型或工具调用。这是已完成任务的结果读取，不是任意执行中 checkpoint 恢复。

## 独立 npm 应用的流程

1. 安装 `@codesoul-co/ditto`、`@codesoul-co/ditto-retrieval`、`redis`。发布前测试可安装本地 `.tgz`。
2. 第三方通过 `defineNode`、`defineWorker` 和 `NodeContractMap` 类型扩展实现自己的包。本例将 `extension/index.ts` 编译成 JS 与声明文件，再单独打包、安装 `@ditto-example/text-worker`；该包名只是本地示例，并未发布。
3. 复制本目录的宿主、CLI、所选 `agent.json` 和 `_shared/tools/storage/`、`_shared/tools/package-basics.ts`，保持相对路径。宿主导入已安装的第三方包，传入 `createTextWorker()`；JSON 的 `deployment.workers[].use` 引用宿主 registry，`bindings` 绑定具体节点。
4. 准备 `input.json`、任务目录中的 `guide.json`，调用 `runScenario()` 或 CLI。保留的验收目录已包含这些文件，可复现读取分支：

```sh
# 在验收打印的独立消费者目录内；环境变量仍由应用提供。
node examples/json-agent/npm-scenarios/cli.mjs \
  examples/json-agent/npm-scenarios/routed/agent.json \
  task/recall-input.json task
```

JSON 可以选择宿主授权的 `count-only` / `no-tools` 服务配置，不能创建工具实现、凭证或自行扩权。修改 JSON 不需要重编译 npm 包；新增第三方实现则需先安装并注册对应 Worker。
