import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."), directory = await mkdtemp(join(tmpdir(), "ditto-agent-package-"));
const execute = (command: string, args: readonly string[], cwd = directory) => execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
try {
  const packed = JSON.parse(execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root)) as { filename: string }[];
  const filename = packed[0]!.filename;
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module",
    dependencies: { "@codesoul-co/ditto": `file:./${filename}` }, devDependencies: { "@types/node": pkg.devDependencies["@types/node"] },
  }));
  execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  for (const file of ["configured-recovery.ts", "configured-recovery.agent.json"])
    await cp(join(root, "docs/worker-api/examples/runtime", file), join(directory, file));
  await writeFile(join(directory, "consumer.ts"), `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { compileAgent, createDitto, loadRuntimeConfig, agentSchema, validateAgent,
  AgentValidationError, AgentPausedError, UncertainGraphCheckpointError, reconcileGraphCheckpoint,
  type AgentCheckpoint, type AgentRunOptions, type GraphCheckpoint } from '@codesoul-co/ditto';
import { recoveryWorker } from './configured-recovery.ts';
const definition: unknown = JSON.parse(await readFile('configured-recovery.agent.json', 'utf8'));
assert.deepEqual(validateAgent(definition), []);
assert.ok(validateAgent({})[0]?.code);
assert.ok(AgentValidationError && AgentPausedError && UncertainGraphCheckpointError && reconcileGraphCheckpoint);
const schemaPath = createRequire(import.meta.url).resolve('@codesoul-co/ditto/agent.schema.json');
assert.deepEqual(JSON.parse(await readFile(schemaPath, 'utf8')), agentSchema);
const options: AgentRunOptions = { stateCheckpoint: { id: 'typecheck', version: '1', save: (_cp: AgentCheckpoint) => {} },
  onBoundary: async boundary => ({ update: { value: boundary.result }, pause: false }) };
assert.ok(options.stateCheckpoint);
const runtime = createDitto({ config: loadRuntimeConfig({}), sandbox: { tools: ['echo'] }, workers: [recoveryWorker()] });
const compiled = compileAgent(definition);
let saved: GraphCheckpoint | undefined;
try {
  const checkpoint = { version: 'tools-v1', save(cp: GraphCheckpoint) { saved = cp; } };
  assert.equal(await compiled.runGraph('stage', runtime, 'standalone', { checkpoint }), 'standalone');
  assert.equal(await compiled.runGraph('stage', runtime, 'standalone', { checkpoint: { ...checkpoint, resume: saved! } }), 'standalone');
  assert.equal(compiled.sourceMap.work?.['prepare/call']?.graphId, 'stage');
} finally { await runtime.close(); }
console.log('Public API, schema, standalone Subgraph and checkpoints passed');
`);
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext",
    moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true, noEmit: true, types: ["node"], skipLibCheck: true }, include: ["*.ts"] }));
  execute(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
  console.log(execute(process.execPath, ["consumer.ts"]).trim());
  const run = (...args: string[]) => JSON.parse(execute(process.execPath, ["configured-recovery.ts", "state", ...args]));
  assert.deepEqual(run("pause"), { paused: true, step: "work", toolCalls: 1 });
  assert.deepEqual(run(), { paused: false, output: "host message", toolCalls: 2 });
  assert.deepEqual(run(), { paused: false, output: "host message", toolCalls: 0 });
  console.log("Installed tarball: strict types, process restart, boundary state patch and completed replay passed");
} finally {
  if (process.argv.includes("--keep")) console.log(`Consumer workspace: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
