/** Reproduce a release install: Core + Retrieval + a separately built third-party Worker. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
const { values } = parseArgs({ options: { keep: { type: "boolean" } } });
const root = process.cwd(), exec = promisify(execFile);
const app = await realpath(await mkdtemp(join(tmpdir(), "ditto-json-npm-")));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const report: Record<string, unknown> = { status: "running", consumer: app, published: false, artifacts: [] };
const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
async function run(command: string, args: string[], cwd = app) {
  try { return (await exec(command, args, { cwd, env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) { if (error && typeof error === "object" && "stderr" in error) console.error(error.stderr); throw error; }
}
async function pack(directory: string) {
  const [artifact] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], directory));
  assert.ok(artifact.files.every((f: { path: string }) => f.path.startsWith("dist/") || /^(package\.json|agent_example\.json|README(?:\.zh-CN)?\.md|LICENSE)$/.test(f.path)));
  (report.artifacts as unknown[]).push({ name: artifact.name, version: artifact.version, integrity: artifact.integrity });
  return join(app, artifact.filename);
}
const compilerOptions = { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
  noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true, noUnusedParameters: true,
  verbatimModuleSyntax: true, types: ["node"] };
try {
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "ditto-json-consumer", private: true, type: "module" }));
  const core = await pack(root), retrieval = await pack(join(root, "packages/retrieval"));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", core, retrieval,
    `typescript@${manifest.devDependencies.typescript}`, `@types/node@${manifest.devDependencies["@types/node"]}`, "redis@6.2.1"]);
  await cp(join(root, "examples/json-agent/npm-scenarios"), join(app, "examples/json-agent/npm-scenarios"), { recursive: true });
  for (const name of ["workers.ts", "redis-context.ts", "sqlite-memory.ts", "sql-memory.ts", "dependencies/package.json"])
    await cp(join(root, "examples/_shared/tools/storage", name), join(app, "examples/_shared/tools/storage", name));
  await cp(join(root, "examples/_shared/tools/package-basics.ts"), join(app, "examples/_shared/tools/package-basics.ts"));
  const extension = join(app, "examples/json-agent/npm-scenarios/extension");
  await writeFile(join(extension, "tsconfig.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, declaration: true, outDir: "dist" }, include: ["index.ts"] }));
  await run(join(app, "node_modules/.bin/tsc"), ["-p", join(extension, "tsconfig.json")]);
  const extensionTarball = await pack(extension);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", extensionTarball]);
  // Remove the extension source before consumer checking/running; only its installed exports remain.
  await rm(extension, { recursive: true });
  await writeFile(join(app, "contract.ts"), `import {createTextWorker} from '@ditto-example/text-worker';
import type {TextRequest} from '@ditto-example/text-worker';
import type {InputOf, OutputOf} from '@codesoul-co/ditto/contracts';
import {createAgent} from '@codesoul-co/ditto/runtime';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Expect<T extends true>=T;
export type Contract=[Expect<Equal<InputOf<'EXAMPLE.NPM.TEXT.NORMALIZE'>,TextRequest>>,Expect<Equal<OutputOf<'EXAMPLE.NPM.TEXT.FORMAT'>,{text:string}>>];
export async function make(definition: unknown) {return createAgent(definition,{workers:{text:createTextWorker()}});}
`);
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true, allowImportingTsExtensions: true }, include: ["examples/**/*.ts", "contract.ts"] }));
  await run(join(app, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  for (const name of ["@codesoul-co/ditto", "@codesoul-co/ditto-retrieval", "@ditto-example/text-worker"]) {
    assert.equal((await lstat(join(app, "node_modules", name))).isSymbolicLink(), false);
    assert.equal(await access(join(app, "node_modules", name, "src")).then(() => true, () => false), false);
  }
  // Enforce external-consumer resolution for both the main process and its restart subprocess.
  await writeFile(join(app, "boundary.mjs"), `import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {relative,isAbsolute} from 'node:path';
const app=${JSON.stringify(app)};
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@codesoul-co/ditto/') && !${JSON.stringify(Object.keys(manifest.exports).map(k => manifest.name + k.slice(1)))}.includes(specifier)) throw Error('Non-public entry: '+specifier);
  const result=next(specifier,context);
  if(result.url.startsWith('file:')) {const path=relative(app,fileURLToPath(result.url)); if(isAbsolute(path)||path==='..'||path.startsWith('../')) throw Error('Module outside npm consumer');}
  return result;
}});`);
  env.NODE_OPTIONS = `--import=${join(app, "boundary.mjs")}`;
  assert.equal(await run(process.execPath, ["--input-type=module", "-e", "await import('./examples/json-agent/npm-scenarios/host.ts'); await import('./examples/json-agent/npm-scenarios/cli.mjs'); await import('@ditto-example/text-worker');"]), "");
  await run(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; await assert.rejects(import('@codesoul-co/ditto/src/index.ts')); await assert.rejects(import(${JSON.stringify(join(root, "dist/index.js"))}));`]);
  report.consumerChecks = { strictTypes: true, installedExtensionTypes: true, noSourceAliases: true, importBoundary: true, silentImports: true };
  console.log(`Installed three tarballs; strict consumer types passed. Running live scenarios in ${app}`);
  const output = await run(process.execPath, ["examples/json-agent/npm-scenarios/acceptance.mjs", "task"]);
  console.log(output.trim());
  const results = JSON.parse(await readFile(join(app, "task/results.json"), "utf8"));
  assert.equal(results.status, "passed");
  report.status = "passed"; report.results = results.results;
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error);
  try { report.acceptance = JSON.parse(await readFile(join(app, "task/results.json"), "utf8")); } catch { /* Failure before scenario execution. */ }
  throw error;
} finally {
  await writeFile(join(root, ".examples-json-agent-package-live-results.json"), JSON.stringify(report, null, 2) + "\n");
  if (!values.keep) await rm(app, { recursive: true, force: true });
}
