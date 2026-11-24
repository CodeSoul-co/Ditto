import { translator } from "./i18n.js";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { discuss } from "./assistant.mjs";
import { newLoop, newSubgraph, insertCall } from "./structure.js";
import { workers, makeNode } from "./catalog.js";
import { appendNode } from "./connections.js";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { checkDefinition } from "./draft.mjs";
import { createModelSettings } from "./models.mjs";

const config = loadRuntimeConfigFile();
const models = createModelSettings(config);
const initialFile = resolve(process.argv[2] || "agent_example.json");
const staticFiles = new Map([
  ["/logo_project.png", ["../logo_project.png", "image/png"]],
  ["/", ["index.html", "text/html"]],
  ["/editor.css", ["editor.css", "text/css"]],
  ["/picker.js", ["picker.js", "text/javascript"]],
  ["/model-dialog.js", ["model-dialog.js", "text/javascript"]],
  ["/editor.js", ["editor.js", "text/javascript"]],
  ["/import-dialog.js", ["import-dialog.js", "text/javascript"]],
  ["/edge-dialog.js", ["edge-dialog.js", "text/javascript"]],
  ["/examples/museum/agent.json", ["examples/museum/agent.json", "application/json"]],
  ["/examples/library-returns.json", ["examples/library-returns.json", "application/json"]],
  ["/i18n.js", ["i18n.js", "text/javascript"]],
  ["/structure.js", ["structure.js", "text/javascript"]],
  ["/structure-dialog.js", ["structure-dialog.js", "text/javascript"]],
  ["/catalog.js", ["catalog.js", "text/javascript"]],
  ["/sidebar.js", ["sidebar.js", "text/javascript"]],
  ["/markdown-it.min.js", [import.meta.resolve("markdown-it/dist/markdown-it.min.js"), "text/javascript"]],
  ["/discussions.js", ["discussions.js", "text/javascript"]],
  ["/canvas.js", ["canvas.js", "text/javascript"]],
  ["/canvases.js", ["canvases.js", "text/javascript"]],
  ["/canvas-menus.js", ["canvas-menus.js", "text/javascript"]],
  ["/connections.js", ["connections.js", "text/javascript"]],
  ["/loop-map.js", ["loop-map.js", "text/javascript"]],
  ["/local-loops.js", ["local-loops.js", "text/javascript"]],
  ["/loop-colors.js", ["loop-colors.js", "text/javascript"]],
]);
const port = Number(process.env.DITTO_EDITOR_PORT || 4317);
const host = "127.0.0.1";
const origin = `http://${host}:${port}`;

function installedWorkers() {
  return workers
    .filter((worker) => {
      if (!worker.packageName) return true;
      try {
        return existsSync(new URL(import.meta.resolve(worker.packageName)));
      } catch {
        return false;
      }
    })
    .map((worker) => worker.name);
}
async function payload(req, t) {
  if (req.headers["content-type"] !== "application/json") throw new Error(t("jsonRequest"));
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4_000_000) throw new Error(t("oversize"));
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function chat({ definition, graph, prompt, history = [], attachment }, signal, locale, t) {
  const check = (value) => checkDefinition(value, true);
  check(definition);
  if (
    attachment &&
    (typeof attachment.name !== "string" ||
      typeof attachment.text !== "string" ||
      !/\.(md|markdown)$/i.test(attachment.name) ||
      Buffer.byteLength(attachment.text) > 32768)
  )
    throw new Error(t("mdLimit"));
  if (typeof prompt !== "string" || (!prompt.trim() && !attachment) || prompt.length > 8000)
    throw new Error(t("promptSize"));
  if (!Object.hasOwn(definition.graphs, graph)) throw new Error(t("missingGraph"));
  const { provider, model } = models.active || {};
  const command = prompt.trim();
  if (attachment) {
    if (!provider) throw new Error(t("offline"));
    return discuss({
      provider,
      model,
      definition,
      graph,
      command,
      history,
      attachment,
      signal,
      locale,
      available: installedWorkers(),
      check,
      t,
    });
  }
  const range =
    /^(?:repeat (?:the )?path )([\w-]+)\s+(?:to|through)\s+([\w-]+)\s+(\d+) times[.!]?$/i.exec(command) ||
    /^(?:循环|重复)(?:路径)?\s*([\w-]+)\s*(?:到|至|→)\s*([\w-]+)\s*(\d+)\s*次[。！]?$/u.exec(command);
  const self =
    /^repeat (?:the )?(?:(?:node|subgraph) )?([\w-]+)\s+(\d+) times[.!]?$/i.exec(command) ||
    /^(?:让|将)?(?:节点|子图)\s*([\w-]+)\s*(?:自己)?(?:循环|重复)\s*(\d+)\s*次[。！]?$/u.exec(command);
  if (range || self) {
    const entry = (range || self)[1],
      end = range?.[2] ?? entry;
    const loops = (definition.graphs[graph].loops ??= []);
    const existing = loops.find((r) => r.entry === entry && r.end === end);
    const maxIterations = Number(range?.[3] ?? self[2]);
    if (existing) existing.maxIterations = maxIterations;
    else loops.push({ entry, end, maxIterations });
    check(definition);
    return { definition, message: t("rangeApplied", { entry, end, count: maxIterations }) };
  }
  const createGraph =
    /^(?:create (?:a )?subgraph(?: named)?\s+|创建(?:一个)?(?:名为)?子图\s*)([A-Za-z_][\w-]*)[。.!]?$/i.exec(
      command,
    );
  if (createGraph) {
    const name = createGraph[1];
    if (Object.hasOwn(definition.graphs, name)) throw new Error(t("duplicateGraph"));
    Object.defineProperty(definition.graphs, name, {
      value: newSubgraph(),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    insertCall(definition, graph, name);
    check(definition);
    return { definition, message: t("graphCreated", { name, graph }) };
  }
  if (/^(?:add (?:a )?loop|添加(?:一个)?(?:循环|loop))[。.!]?$/i.test(command)) {
    if (definition.loop) return { message: t("loopExists") };
    definition.loop = newLoop();
    delete definition.entry;
    check(definition);
    return { definition, message: t("loopAdded") };
  }
  if (/^(?:remove (?:the )?loop|(?:删除|移除)(?:循环|loop))[。.!]?$/i.test(command) && definition.loop) {
    delete definition.loop;
    check(definition);
    return { definition, message: t("loopRemoved") };
  }
  const rename = /^(?:将 Agent 命名为|rename (?:the )?agent to)\s+([\w-]+)$/i.exec(command);
  const repeat = /^(?:将循环预算设为|set (?:the )?loop budget to)\s*(\d+)$/i.exec(command);
  if (rename) {
    definition.id = rename[1];
    check(definition);
    return { message: t("renamed", { id: definition.id }), definition };
  }
  if (repeat && definition.loop) {
    definition.loop.maxIterations = Number(repeat[1]);
    check(definition);
    return { message: t("budget", { count: repeat[1] }), definition };
  }
  const shortcuts = new Map([
    [translator("zh-CN")("addContext"), "CONTEXT.LOAD"],
    [translator("en")("addContext"), "CONTEXT.LOAD"],
    ["添加记忆", "MEMORY.WRITE"],
    ["添加记忆节点", "MEMORY.WRITE"],
    ["add memory", "MEMORY.WRITE"],
  ]);
  const type = shortcuts.get(command) || shortcuts.get(command.toLowerCase());
  if (type) {
    const nodes = definition.graphs[graph].nodes;
    const option = workers.flatMap((w) => w.nodes).find((n) => n.type === type);
    const added = makeNode(option, nodes);
    appendNode(definition.graphs[graph], added);
    check(definition);
    return { message: t("inserted", { graph, id: added.id, type }), definition };
  }
  if ([translator("zh-CN")("explain"), translator("en")("explain")].includes(command)) {
    const { nodes } = definition.graphs[graph];
    if (!nodes.length) return { message: t("emptyGuide"), recommendations: ["CONTEXT.LOAD"] };
    return {
      message: nodes
        .map((n) =>
          t("nodeInfo", {
            id: n.id,
            operation: n.kind === "subgraph" ? t("calls", { graph: n.graph }) : n.type,
            order: n.dependsOn?.length
              ? t("waits", { nodes: n.dependsOn.join(locale === "en" ? ", " : "、") })
              : t("ready"),
          }),
        )
        .join("\n"),
    };
  }
  if (!provider) throw new Error(t("offline"));
  return discuss({
    provider,
    model,
    definition,
    graph,
    command,
    history,
    signal,
    locale,
    available: installedWorkers(),
    check,
    t,
  });
}
const server = createServer(async (req, res) => {
  const locale = /^en\b/i.test(req.headers["accept-language"] || "") ? "en" : "zh-CN";
  const t = translator(locale);
  const reply = (code, data) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };
  try {
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin))
      return reply(403, { error: t("localOnly") });
    if (req.url === "/api/model") {
      if (req.method === "GET") return reply(200, models.snapshot());
      if (req.method === "POST") return reply(200, models.update(await payload(req, t), t));
    }
    const file = staticFiles.get(req.url);
    if (req.method === "GET" && file) {
      const body = await readFile(new URL(file[0], import.meta.url));
      res.writeHead(200, {
        "content-type": file[1] + "; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      });
      return res.end(body);
    }
    if (req.method === "GET" && req.url === "/api/start") {
      const definition = JSON.parse(await readFile(initialFile, "utf8"));
      checkDefinition(definition, true);
      return reply(200, {
        definition,
        filename: basename(initialFile),
        installedWorkers: installedWorkers(),
        model: models.active?.model.model,
      });
    }
    if (req.method === "POST" && req.url === "/api/check") {
      const { definition, draft } = await payload(req, t);
      checkDefinition(definition, draft === true);
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      return reply(200, await chat(await payload(req, t), controller.signal, locale, t));
    }
    reply(404, { error: t("missingPage") });
  } catch (e) {
    if (!res.destroyed) reply(400, { error: e.message });
  }
});
server.listen(port, host, () => console.log(`Ditto Graph Editor  ${origin}`));
