/** Same agent.json over authenticated HTTP; application resources stay on the Worker host. */
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { compileAgent, createDitto, createHttpTransport, createWorkerHttpHandler } from "@codesoul-co/ditto/runtime";
import { openScenarioResources, validateScenarioRequest } from "./host.ts";

export async function startWorkerServer(directory, { token, port = 8080, host = "127.0.0.1", url } = {}) {
  if (typeof token !== "string" || !token.trim()) throw new Error("Set DITTO_TRANSPORT_HTTP_WORKER_TOKEN");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Worker port");
  const resources = await openScenarioResources(directory);
  const runtime = createDitto({ config: resources.config, hostId: "worker-host" });
  const server = createServer(createWorkerHttpHandler(runtime, { token }));
  async function close() {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { await runtime.close(); } finally { await resources.close(); }
  }
  try {
    for (const [id, worker] of Object.entries(resources.workers)) runtime.register(worker, {
      id, ...(id === "interaction" ? { services: resources.serviceProfiles["count-only"] } : {}),
    });
    server.listen(port, host);
    await once(server, "listening");
    const address = server.address();
    const manifest = {
      url: url ?? `http://127.0.0.1:${address.port}/ditto/invoke`, model: resources.model,
      workers: runtime.workers().map(({ address, capabilities }) => ({ address, capabilities })),
    };
    return { manifest, trace: resources.trace, close };
  } catch (error) { await close(); throw error; }
}

export async function runRemoteScenario(definition, request, manifest, token) {
  if (typeof token !== "string" || !token.trim()) throw new Error("Set DITTO_TRANSPORT_HTTP_WORKER_TOKEN");
  validateScenarioRequest(request);
  const compiled = compileAgent(definition);
  const transport = createHttpTransport({ id: "worker-http", url: manifest.url, token, timeoutMs: 180_000 });
  const runtime = createDitto({ hostId: "controller", transports: [transport] });
  try {
    for (const worker of manifest.workers) runtime.registerRemote({ ...worker, transportId: transport.id });
    // Worker IDs match agent.json bindings; no Graph or Loop rewriting is needed.
    return await compiled.run(runtime, { ...request, model: manifest.model }, { signal: AbortSignal.timeout(180_000) });
  } finally { await runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, first, second, third] = process.argv.slice(2);
  const token = process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN;
  if (mode === "serve" && first && second) {
    const worker = await startWorkerServer(first, {
      token, port: Number(process.env.DITTO_EXAMPLE_WORKER_PORT ?? 8080),
      host: process.env.DITTO_EXAMPLE_WORKER_BIND ?? "127.0.0.1", url: process.env.DITTO_EXAMPLE_WORKER_URL,
    });
    let stop;
    try {
      await writeFile(second, JSON.stringify(worker.manifest, null, 2));
      console.log(`Worker deployment written to ${second}`);
      await new Promise(resolve => { stop = resolve; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    } finally {
      if (stop) { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      await worker.close();
    }
  } else if (mode === "run" && first && second && third) {
    const [definition, request, manifest] = await Promise.all([first, second, third].map(async path => JSON.parse(await readFile(path, "utf8"))));
    console.log(JSON.stringify(await runRemoteScenario(definition, request, manifest, token)));
  } else {
    throw new Error("Usage: remote.mjs serve task-directory deployment.json | run agent.json input.json deployment.json");
  }
}
