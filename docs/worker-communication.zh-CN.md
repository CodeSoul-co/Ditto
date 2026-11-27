# Worker 通信与部署

[English](worker-communication.md) · **简体中文**

> Runtime 的 `invoke` / `emit` 是内部通信语义，不属于 Interaction Node。应用 Graph 与 Loop 调用公开的叶子能力，Loop 和状态留在调用端。

## 位置与调用

| 位置 | 当前实现 | 数据与执行 |
| --- | --- | --- |
| 同进程 | 直接调用 Worker executor | 保留对象身份，不序列化 |
| 同机不同进程 | Node 原生 IPC；也可使用 HTTP loopback | 序列化公开 Node 调用；路由优先于跨 host |
| 跨服务器 | HTTP(S) transport + 接收 handler | 认证、Envelope 校验、响应关联、大小与超时限制 |

`ctx.invoke` 和顶层 `runtime.invoke` 使用同一个能力路由。HTTP Adapter 使用标准库，不依赖 Express 等框架；worker_threads / MessagePort / NATS 等需要提供自己的 `InvokeTransport`。HTTP 是实际可用的网络适配器，测试通过真实 loopback socket 验证。

## 同机 IPC

使用 `createIpcTransport({ id, channel: child, timeoutMs })` 将 `node:child_process.fork` 返回的 ChildProcess 接到调用端；子进程注册 Worker 后执行 `serveWorkerIpc(runtime, process)`。登记两端共享的 hostId、不同 processId 及准确的 Worker 地址，再用 registerRemote 绑定 transport。Runtime 优先选择同进程，再选择同 host，最后跨 host；指定 workerId 时严格使用该副本。

IPC 复用父子进程的内置 channel，不开 TCP 端口、不需要网络 token。调用仍经过 Envelope、目标身份、公开能力与容量检查；业务输入输出应保持可序列化。超时、取消和断开会结束调用端等待，但不会回滚或强制停止远端任务。应用拥有子进程及 transport 生命周期，退出前调用 ipc.close()；接收端 receiver.close() 停止新入口并等待已接受回复。

完整双模式示例见 [placement.ts](worker-api/examples/runtime/placement.ts)，详细接口见 [Runtime API](worker-api/runtime.zh-CN.md)。

## HTTP 示例

以下为两个进程各自的启动代码，按部署配置交换注册地址。公开 Node 实现及内部 Graph 需要事先部署到执行端。

服务端：

```ts
import { createServer } from "node:http";
import { createDitto, createContextWorker, loadRuntimeConfigFile, createWorkerHttpHandler } from "@codesoul-co/ditto";

const token = process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_TRANSPORT_HTTP_WORKER_TOKEN");
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ hostId: "server-a", processId: "agent-service", config });
const worker = runtime.register(createContextWorker({ policy: config.context.policy ?? {}, concurrency: 8 }), "context-a");
const server = createServer(createWorkerHttpHandler(runtime, { token }));
server.listen(8080, "127.0.0.1");
console.log(worker.address); // 通过部署配置传给调用端；不含 Key
```

调用端：

```ts
import { createDitto, createHttpTransport } from "@codesoul-co/ditto";

const token = process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_TRANSPORT_HTTP_WORKER_TOKEN");
const transport = createHttpTransport({
  id: "server-a-http", url: "http://127.0.0.1:8080/ditto/invoke", token, timeoutMs: 30_000,
});
const runtime = createDitto({ hostId: "client", transports: [transport] });
runtime.registerRemote({
  address: { workerId: "context-a", workerType: "CONTEXT", hostId: "server-a", processId: "agent-service" },
  capabilities: ["CONTEXT.LOAD"], transportId: transport.id,
});
try {
  console.log(await runtime.invoke("CONTEXT.LOAD", { sources: [{ role: "user", content: "hello" }] }));
} finally { await runtime.close(); }
```

跨服务器将地址换为受控 HTTPS 入口，在服务前配置 TLS 或使用 Node HTTPS Server；明文 loopback 示例用于本机开发。为多个服务器分别安装 transport，再注册各自地址。相同 capability 会自然参与路由，无需改变 Graph。

相同注册方式适用于 `runtime.run()` 与 `runtime.loop()`。Loop 可每轮选择不同 DAG，只有该 DAG 的 Node 调用经过 HTTP。部署并公开所有可能选中 Graph 所需的能力。模型调用使用业务输入中的 model，并由服务端 Provider 绑定解析；需要工具的应用还需部署 Interaction 能力，并让模型可见工具 schema 与执行权限保持一致。远端注册不会上传 Graph 函数或 Loop 状态机。

## 协议与责任

请求包含 invocation ID、源/目标 Worker 地址、Node 名称、payload，以及可选的 Graph/run/task 标识。响应 ID 必须匹配。HTTP 请求使用 `x-ditto-protocol: 1`、Bearer token，默认 body 上限 1 MiB；拒绝重定向以避免认证头流向其他地址。

接收 handler 验证 Envelope 形状；Runtime 再验证目标 host/process/type/id、公开能力与可用状态。业务 input 的语义校验仍由 Node/工具执行器承担；TypeScript 声明不是对网络输入的运行时校验。HTTP 错误不返回 handler 堆栈或 Provider 响应正文。

Token 是服务级凭证，可调用该服务 Runtime 内所有公开能力，不是租户或单 Node ACL。外部请求应通过应用自己的认证/租户网关；限制公开入口用 `expose`。执行端使用自己的 Provider Key、连接与 Sandbox 配置，Envelope 不接受这些设置的覆盖；INFER 的业务输入仍显式包含 model，由执行端已配置 Provider 解析。业务输入本身仍可能包含敏感内容，应按应用需要管理日志和存储。

默认每次调用只派发一次。超时或断线后，远端可能已经完成操作。HTTP 取消会结束调用方的等待，远端仍可能继续执行。

### 执行事件与可选的跨 Worker 故障转移

宿主在 `createDitto` 或 `createAgent` 上分别配置 `onExecutionEvent` 和 `recoveryPolicy`。下面的配置允许一次初始派发和一次重试。

```ts
const runtime = createDitto({
  onExecutionEvent(event) { console.log(event); },
  recoveryPolicy: { maxAttempts: 2 },
});
```

- **跟踪调用。** 一次逻辑调用派发时产生 `operation.dispatched`。每次实际尝试产生 `attempt.started` 以及后续的 `attempt.succeeded` 或 `attempt.failed`。各次尝试共享 `operationId`，各自的 `attemptId` 与传输层调用 ID 一致。Worker 可通过 `ctx.invocation` 读取两者。成功返回的推理尝试可携带 Provider 报告的用量，丢失回执的尝试用量未知。
- **区分采纳和持久化。** `operation.committed` 指明采纳的尝试，在 Graph 中发生于节点输出校验之后。宿主成功保存后才产生 `checkpoint.saved`，其中带检查点摘要。Graph 调用带运行和叶子节点标识，Graph 检查点事件列出已确认和待核对的叶子 ID。Graph 检查点恢复时沿用运行标识，配置化 Loop 的每轮 Graph 则有独立标识。恢复已确认输出时直接复用结果。`checkpoint.restored` 标明读到的快照。离线核对时可将同一观察函数作为第三个参数传给 `reconcileGraphCheckpoint`，通过 `checkpoint.reconciled` 记录核对决定，再由宿主持久保存。
- **观察 Worker 状态。** IPC 断线或宿主将注册实例标为不可用时产生 `worker.unavailable`。HTTP 超时仅反映本次尝试的情况。事件由派发方记录，调度器不等待异步导出，观察函数异常也不会改变执行结果。
- **跨实例重试。** 次数上限包含首次尝试。未固定绑定的调用可以转到另一个已注册、能力匹配且有空闲容量的实例，每个 Worker ID 最多尝试一次。默认策略只重试状态为 `not_sent` 的通道关闭、Worker 退出、通信错误和超时。参数错误、协议错误、远端业务异常和固定绑定直接返回错误。取消后停止派发。`recovery.decided` 记录决定，重试时也记录目标 Worker。
- **核对未知结果。** 可提供 `shouldRetry({ operationId, node, input, error, signal })`，异步查询回执，确认可安全重放时返回 true。涉及外部写入时，各副本需要共享幂等键或等效协调机制。尝试预算作用于本次在线调用；进程重启后，检查点中的未确认意图仍需显式核对。

服务停止时先停止接收新 HTTP 请求，等待应用顶层任务，再关闭 Runtime 和 Server；MCP、Provider 外部连接由拥有者关闭。`registerRemote` 只是本地目录登记，不会启动服务器或把 Worker 代码复制到另一台机器。

## invoke、emit 与 Artifact

`invoke` 是请求/响应；`emit` 是向 EventFabric 提交事件。默认 LocalEventFabric 是本进程异步 fan-out，emit 返回仅代表已接受。`drainEvents()` 返回消费失败记录；Runtime.close 不自动关闭共享 EventFabric。跨服务器 Pub/Sub 需要注入外部 EventFabric，与请求 transport 分离；HTTP invoke 不会隐式转发事件。

跨传输 payload 有 `inline` 和 `reference` 两种。配置 ArtifactStore 后，超过 inlineLimitBytes（默认 64 KiB）的 JSON 数据可卸载为引用；响应也同样处理。同进程直接调用不做大小扫描。

InMemoryArtifactStore 仅适用于单进程实验。跨主机引用需要两端可访问的外部 Store/Resolver；访问控制、TTL 与清理由存储实现负责。自动生成的引用不会自动回收。无共享 Store 时保持 inline 并设置适当 body 上限。当前网络边界只支持 JSON 可编码输入输出，不支持任意 class、函数、undefined 或二进制流。

ArtifactStore、PayloadCodec、EventFabric 的逐方法示例见 [组合 API](worker-api/composition.zh-CN.md)。
