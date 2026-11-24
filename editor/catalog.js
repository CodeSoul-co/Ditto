import { withoutGraphInput } from "./connections.js";
// Form defaults are Agent expressions. The user can map them to graph input or upstream nodes.
const ref = (path) => ({ $ref: path });
const input = ref("input");
const context = ref("input.context");
const model = ref("input.model");
const messages = ref("input.messages");
const cacheKey = { scope: "sample", key: ref("input.key") };
function node(type, zh, en, input) {
  return { type, description: { "zh-CN": zh, en }, input };
}
export const workers = [
  {
    name: "CONTEXT",
    title: { "zh-CN": "上下文", en: "Context" },
    nodes: [
      node(
        "CONTEXT.LOAD",
        "把消息、条目或引用载入本轮上下文。",
        "Load messages, items or references into the working context.",
        { sources: [{ role: "user", content: input }] },
      ),
      node(
        "CONTEXT.SELECT",
        "按用途与预算选取本轮需要的条目。",
        "Select context items for a purpose and budget.",
        { context, purpose: "infer" },
      ),
      node(
        "CONTEXT.UPDATE",
        "将新条目合入工作集，或移除已有条目。",
        "Merge new items into the working set or remove existing ones.",
        { context, add: ref("input.items") },
      ),
      node(
        "CONTEXT.COMPRESS",
        "在保留受保护条目的前提下裁剪工作集。",
        "Trim the working set to a budget while keeping protected items.",
        { context, maxItems: 16 },
      ),
    ],
  },
  {
    name: "MEMORY",
    title: { "zh-CN": "长期记忆", en: "Memory" },
    nodes: [
      node("MEMORY.GET", "用已知的 ID 或键读取记忆。", "Read stored memories by ID or key.", {
        keys: [ref("input.key")],
      }),
      node(
        "MEMORY.QUERY",
        "按条件、排序和分页列出记忆。",
        "List and page through records using filters and ordering.",
        { limit: 10 },
      ),
      node("MEMORY.SEARCH", "用查询内容搜索相关记忆。", "Search for memories relevant to a query.", {
        query: input,
        limit: 5,
      }),
      node("MEMORY.WRITE", "将新的内容写入长期记忆。", "Create durable memory records from new content.", {
        memories: [{ content: input }],
      }),
      node(
        "MEMORY.UPDATE",
        "按 ID 更新已有记忆的内容或元数据。",
        "Update a stored record’s content or metadata by ID.",
        { memories: [{ id: ref("input.id"), content: ref("input.content") }] },
      ),
      node(
        "MEMORY.DELETE",
        "按 ID 删除指定的记忆记录。",
        "Delete the memory records identified by the supplied IDs.",
        { ids: ref("input.ids") },
      ),
    ],
  },
  {
    name: "INFER",
    title: { "zh-CN": "推理", en: "Inference" },
    nodes: [
      node(
        "INFER.REASONING.SAMPLE",
        "调用一次模型，生成回复或动作请求。",
        "Call the model once for a reply or an action request.",
        { model, messages },
      ),
      node(
        "INFER.REASONING.TRAJECTORY",
        "按指定策略组织多步推理并限制步数。",
        "Run a bounded sequence of reasoning steps using a strategy.",
        { model, messages, strategy: { name: "cot" }, constraints: { maxSteps: 3 } },
      ),
      node(
        "INFER.REASONING.REFLECT",
        "审查、验证或修订已有结果。",
        "Critique, verify or revise an existing result.",
        { model, mode: "verify", target: { result: ref("input.result") } },
      ),
      node(
        "INFER.REASONING.DELIBERATE",
        "对多个候选结果进行比较、选择或合并。",
        "Compare several candidates and select or merge their results.",
        { model, mode: "select", candidates: ref("input.candidates") },
      ),
      node(
        "INFER.CACHE.LOOKUP",
        "通过缓存键查找可复用的推理结果。",
        "Look up a reusable computation by its cache key.",
        { key: cacheKey },
      ),
      node("INFER.CACHE.WRITE", "将计算结果写入推理缓存。", "Store a computation result for later reuse.", {
        key: cacheKey,
        value: ref("input.value"),
      }),
      node(
        "INFER.CACHE.INVALIDATE",
        "按键、标签或命名空间清理缓存。",
        "Invalidate cached computations by key, tag or namespace.",
        { selector: { type: "key", key: cacheKey } },
      ),
    ],
  },
  {
    name: "INTERACTION",
    title: { "zh-CN": "外部交互", en: "Interaction" },
    nodes: [
      node("INTERACTION.ACT.TOOL", "调用宿主已注册的工具。", "Invoke a tool registered by the host.", {
        call: ref("input.call"),
      }),
      node(
        "INTERACTION.ACT.MCP",
        "发现或调用已连接的 MCP 服务能力。",
        "Discover capabilities or invoke a tool on a connected MCP server.",
        { operation: "discover" },
      ),
      node(
        "INTERACTION.OBSERVE",
        "把外部执行结果转换成可供模型读取的观察消息。",
        "Turn an external result into an observation and a tool message.",
        { result: ref("input.result") },
      ),
      node(
        "INTERACTION.OUTPUT",
        "向输出通道提交消息并获取交付回执。",
        "Deliver a message to an output sink and receive its receipt.",
        { deliveryId: ref("input.deliveryId"), message: ref("input.message") },
      ),
    ],
  },
  {
    name: "RETRIEVAL",
    title: { "zh-CN": "检索", en: "Retrieval" },
    packageName: "@codesoul-co/ditto-retrieval",
    nodes: [
      node(
        "RETRIEVAL.SEARCH",
        "在指定数据源中检索并返回排序后的候选条目。",
        "Search a target corpus and return ranked candidates.",
        { query: { content: ref("input.query") }, target: { name: ref("input.target") }, limit: 5 },
      ),
    ],
  },
];
export function makeNode(option, existing) {
  const base = option.type.split(".").at(-1).toLowerCase();
  let id = base;
  for (let i = 2; existing.some((n) => n.id === id); i++) id = base + i;
  const input = structuredClone(option.input);
  return { id, type: option.type, input: existing.length ? withoutGraphInput(input) : input };
}
