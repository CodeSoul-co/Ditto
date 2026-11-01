import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Agent and Runtime automatically load cwd YAML once; explicit config wins and invalid files fail", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ditto-autoconfig-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DITTO_") && key !== "NODE_OPTIONS"));
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {writeFileSync, rmSync, mkdirSync} from 'node:fs';
      // Importing and compiling must remain pure, even beside a malformed file.
      writeFileSync('ditto.yaml', 'runtime: [');
      const {createAgent, compileAgent, createDitto, loadRuntimeConfig, createContextWorker} = await import(${JSON.stringify(new URL("../src/index.js", import.meta.url).href)});
      const definition = {version: 1, id: 'auto', graphs: {main: {nodes: [{id: 'load', type: 'CONTEXT.LOAD', input: {
        sources: [{role: 'user', content: 'one'}, {role: 'user', content: 'two'}]
      }}], output: {$ref: 'nodes.load'}}}};
      compileAgent(definition);
      assert.throws(() => createDitto());
      await assert.rejects(createAgent(definition, {workers: {context: createContextWorker()}}));
      rmSync('ditto.yaml');
      writeFileSync('.env', 'DITTO_RUNTIME_ENV=production');
      const fallback = createDitto();
      assert.equal(fallback.services.config.environment, 'test');
      assert.equal(fallback.services.config.graphConcurrency, Infinity);
      await fallback.close();
      writeFileSync('ditto.yaml', 'runtime:\\n  graphConcurrency: 1\\nworkers:\\n  context:\\n    policy:\\n      maxItems: 1\\n');
      const agent = await createAgent(definition, {workers: {context: createContextWorker()}});
      assert.equal(agent.runtime.services.config.graphConcurrency, 1);
      assert.equal(agent.runtime.services.config.environment, 'test');
      await assert.rejects(agent.run(null), /limit/i);
      const overridden = await createAgent(definition, {workers: {context: createContextWorker({policy: {maxItems: 2}})}});
      assert.equal((await overridden.run(null)).items.length, 2);
      writeFileSync('ditto.yaml', 'runtime: {graphConcurrency: 0}');
      // Existing instances keep their startup configuration.
      assert.equal((await overridden.run(null)).items.length, 2);
      assert.throws(() => createDitto(), /graphConcurrency/);
      const config = loadRuntimeConfig({}, {runtime: {graphConcurrency: 7}});
      const explicit = await createAgent(definition, {config, workers: {context: createContextWorker()}});
      assert.equal(explicit.runtime.services.config, config);
      assert.equal(explicit.runtime.services.config.environment, 'development');
      assert.equal((await explicit.run(null)).items.length, 2);
      await Promise.all([agent.close(), overridden.close(), explicit.close()]);
      rmSync('ditto.yaml'); mkdirSync('ditto.yaml');
      assert.throws(() => createDitto(), {code: 'EISDIR'});
      console.log('passed');
    `], { cwd, env: { ...env, DITTO_RUNTIME_ENV: "test" }, encoding: "utf8" });
    assert.equal(output.trim(), "passed");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
