# 检查点、隔离状态与 token 预算

[English](checkpoints.md) · **简体中文** · [Worker API](README.zh-CN.md)

以下 API 从 `@codesoul-co/ditto@0.1.1` 的根入口或 `/runtime` 公开导出，均需应用显式启用；已有执行方式不变。

## 可移植状态

```js
import { checkpointState, restoreState, BranchStore } from '@codesoul-co/ditto';

const saved = checkpointState('session-1', 'app-config-v1', { step: 3, messages: [] });
const state = restoreState(JSON.parse(JSON.stringify(saved)), 'session-1', 'app-config-v1');

const store = new BranchStore('session-1');
const branch = store.fork();
branch.set('context', state);
branch.set('memory', { note: 'accepted result' });
branch.commit();
const snapshot = store.snapshot(); // 存为 JSON；恢复时使用 new BranchStore(id, snapshot)
```

状态必须是有限、无环的 JSON：普通对象和非稀疏数组可以使用；函数、类实例、生成器和运行中的资源会被拒绝。对象中的 `undefined` 属性会被省略。恢复时校验 scope、version 和 SHA-256 摘要。摘要用于发现意外损坏，不能证明状态没有被恶意篡改；不可信的持久化数据还需单独认证。

`BranchStore` 是单个进程内显式状态命名空间的管理者。分支共享不可变基础值，读写时复制值，每个分支有独立的写入集。`discard()` 关闭分支且不修改父状态；`commit()` 仅在父状态版本仍匹配时一次性应用全部命名空间，否则抛出冲突，不会隐式合并。应用负责持久化 snapshot，包括文件的原子替换。

可将应用拥有的 Context、Memory、artifact 引用和可序列化工具会话放入此 store。它**不会**快照 Redis、SQL 事务、远程工具、进程或文件系统写入。应用必须为这些资源提供事务适配器，或者拒绝 fork/cache 操作；仅创建新的 Runtime 不能隔离外部副作用。

## Graph 与 Loop 恢复

调用 `runtime.run(graph, input, options)` 时，传入 `{ checkpoint: { version, save, resume? } }`。`save` 接收 JSON `GraphCheckpoint`，并在静止边界被等待完成，然后才启动更多 Node。恢复时，已完成的 Node 输出直接从 checkpoint 读取，不再执行。Graph 结构、绑定文本和输入参与哈希；显式的 `version` 还必须标识无法自动检查的配置、闭包捕获值和资源快照。开启 checkpoint 后，Graph 按执行波次推进；普通执行仍使用原有异步调度。

检查点模式现在会在每波执行开始前，将调用意图保存到 `uncertain`；该波次结束后再确认成功输出。因此，崩溃或完成状态保存失败会留下未确认意图。恢复时抛出 `UncertainGraphCheckpointError`；宿主须核对外部回执，并显式调用 `reconcileGraphCheckpoint` 后再继续。这不构成外部操作 exactly-once，应使用幂等键或资源事务。始终重新读取最新持久检查点，不要在已变化资源上重试旧记录。该意图协议是 `0.1.4` 之后的源码新增能力，旧检查点不会自动获得此保证。

对显式状态 Loop，向 `runtime.loop` 传入 `{ stateCheckpoint: { id, version, save, resume? } }`。checkpoint 保存每轮结束后的状态和下一轮序号。`version` 应覆盖 Loop 定义与配置。基于生成器的 plan 不支持此选项，因为 JavaScript 生成器不可序列化；内部 Graph 可以使用各自独立的 checkpoint。

配置化 Agent 通过 `agent.run`／`compiled.run` 的 Agent `stateCheckpoint` 保存显式执行阶段及内部 Graph 检查点，无须序列化生成器；可等待的边界支持状态更新与暂停。新 API、版本说明及宿主存储契约见[配置化 Agent 执行与恢复](../agent-execution.zh-CN.md)。

## 共享计量与准入

```js
import { TokenBudget, budgetedProvider } from '@codesoul-co/ditto';

const budget = new TokenBudget(100_000);
const metered = budgetedProvider(provider, budget, {
  reserveTokens: input => estimateUpperBound(input),
  scope: { runId: 'run-1', branchId: 'candidate-2', label: 'inference' },
  requireUsage: true,
});
// 将 metered 作为普通 ModelProvider 注册；并发 Provider 共享同一个 budget。
```

应用提供 `provider` 和 `estimateUpperBound`。后者必须覆盖完整请求的输入与最大输出，包括协议开销和隐藏推理 token。若估计器不能承诺这个上界，它只能用于保守准入，不能宣称物理硬上限。预留在单个 JS 进程内同步且原子；多进程使用者需要共享的准入管理者，多个独立实例不会共享额度。

成功调用按实际 token 用量结算。失败或取消且缺少用量时，完整预留额会作为 `unknown` 收费；调用前已经取消的请求不准入。无效或缺失的 usage 同样会扣除预留额，`requireUsage` 还会拒绝该结果。实际用量超过预留额时，记录真实收费、抛出 `BudgetExceededError` 并关闭后续准入；已经发生的供应商成本无法撤销。记录保留供应商 usage（包括缓存字段）、预留、收费、状态和 scope。逻辑回放成本应单独记录，恢复 checkpoint 不会再次消耗该预算。包装器使用 `invoke`，流式调用会回退到普通 invoke 路径，以便只进行一次终态结算。
