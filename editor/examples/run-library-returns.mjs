import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createAgent } from "@codesoul-co/ditto/runtime";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { openSqliteMemory } from "../../examples/_shared/tools/storage/sqlite-memory.ts";

const { values, positionals: titles } = parseArgs({ options: { definition: { type: "string" } }, allowPositionals: true });
const source = values.definition ?? new URL("./library-returns.json", import.meta.url);
const definition = JSON.parse(await readFile(source, "utf8"));
const database = join(await mkdtemp(join(tmpdir(), "ditto-library-")), "returns.sqlite");
const memory = openSqliteMemory(database);
try {
  const agent = await createAgent(definition, {
    workers: { memory: createMemoryWorker({ store: memory.store }) },
  });
  try {
    const result = await agent.run({ batch: randomUUID(), ...(titles.length && { titles }) });
    console.log(JSON.stringify({ ...result, database }, null, 2));
  } finally {
    await agent.close();
  }
} finally {
  await memory.close();
}
