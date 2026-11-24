const $ = (id) => document.getElementById(id);

export function initImportDialog({ t, guard, revision, validate, activate, notice }) {
  const dialog = $("import-dialog"),
    source = $("import-source"),
    file = $("upload");
  const examples = dialog.querySelectorAll("[data-example]");
  let job = 0,
    busy = false;
  function controls(loading) {
    busy = loading;
    $("import-file").disabled = source.readOnly = loading;
    for (const button of examples) button.disabled = loading;
    $("import-submit").disabled = loading || !source.value.trim();
  }
  function open() {
    try {
      guard();
    } catch (e) {
      if ($("canvas-library").open) $("history-error").textContent = e.message;
      else notice(e.message);
      return false;
    }
    $("canvas-library").close();
    job++;
    $("import-error").textContent = source.value = "";
    controls(false);
    dialog.showModal();
    return true;
  }
  async function load(read, filename) {
    if (busy || !dialog.open) return;
    const request = ++job,
      before = revision();
    const current = () => request === job && dialog.open;
    controls(true);
    $("import-error").textContent = "";
    try {
      const content = await read();
      let definition;
      try {
        definition = JSON.parse(content.replace(/^\uFEFF/, ""));
      } catch (e) {
        throw new Error(t("importInvalid", { reason: e.message }));
      }
      await validate(definition);
      if (!current()) return;
      guard();
      if (before !== revision()) throw new Error(t("resend"));
      const name = filename || definition.id + ".json";
      const saved = activate(definition, name);
      dialog.close();
      if (saved) notice(t("imported", { name }));
    } catch (e) {
      if (current()) $("import-error").textContent = e.message;
    } finally {
      if (current()) controls(false);
    }
  }
  function files(list) {
    if (list.length !== 1) {
      $("import-error").textContent = t("importSingle");
      return;
    }
    const selected = list[0];
    return load(() => selected.text(), selected.name);
  }
  $("open").onclick = $("history-import").onclick = open;
  $("import-close").onclick = () => dialog.close();
  $("import-file").onclick = () => file.click();
  file.onchange = () => {
    if (file.files.length) files(file.files);
    file.value = "";
  };
  source.oninput = () => controls(false);
  $("import-form").onsubmit = (event) => {
    event.preventDefault();
    if (source.value.trim()) load(() => source.value);
  };
  for (const button of examples) {
    button.onclick = () =>
      load(async () => {
        const res = await fetch("/examples/" + button.dataset.example);
        if (!res.ok) throw new Error(t("requestFailed"));
        return res.text();
      });
  }
  for (const area of [$("import-file"), $("viewport")]) {
    area.addEventListener("dragover", (event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      area.classList.add("file-over");
    });
    area.addEventListener("dragleave", (event) => {
      if (!area.contains(event.relatedTarget)) area.classList.remove("file-over");
    });
    area.addEventListener("drop", (event) => {
      area.classList.remove("file-over");
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      if (dialog.open || open()) files(event.dataTransfer.files);
    });
  }
  return { open };
}
