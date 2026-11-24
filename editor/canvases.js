// Each canvas has its own record. Switching the active canvas only changes a pointer.
export function createCanvasHistory(storage, workspace) {
  const prefix = "ditto-canvases:v1:" + encodeURIComponent(workspace) + ":";
  const records = prefix + "document:";
  const unsaved = new Map();
  function read(id) {
    return unsaved.get(id) || JSON.parse(storage.getItem(records + id));
  }
  function list() {
    const ids = new Set(unsaved.keys());
    for (const key of Object.keys(storage)) if (key.startsWith(records)) ids.add(key.slice(records.length));
    return [...ids]
      .flatMap((id) => {
        try {
          const record = read(id);
          return record?.id === id && record.definition ? [record] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updated - a.updated);
  }
  function write(record) {
    const snapshot = structuredClone({ ...record, updated: Date.now() });
    try {
      storage.setItem(records + record.id, JSON.stringify(snapshot));
      unsaved.delete(record.id);
    } catch (error) {
      unsaved.set(record.id, snapshot);
      throw error;
    }
  }
  return {
    list,
    read,
    write,
    recordKey: (id) => records + id,
    remove(id) {
      storage.removeItem(records + id);
      unsaved.delete(id);
      if (storage.getItem(prefix + "active") === id) {
        const latest = list()[0];
        if (latest) storage.setItem(prefix + "active", latest.id);
        else storage.removeItem(prefix + "active");
      }
    },
    active: () => storage.getItem(prefix + "active"),
    select: (id) => storage.setItem(prefix + "active", id),
  };
}

export function blankDefinition(id, previous = {}) {
  const { $schema, config } = previous;
  return {
    ...($schema !== undefined && { $schema }),
    version: 1,
    id,
    ...(config !== undefined && { config }),
    graphs: { main: { nodes: [] } },
  };
}
