import { createPicker } from "./picker.js";
export function initModelDialog({ api, t, notice }) {
  const $ = (id) => document.getElementById(id),
    dialog = $("model-dialog");
  let settings, id;
  const picker = createPicker($("provider-picker"), (value) => show(value));
  function show(value) {
    id = value;
    const item = settings.providers.find((p) => p.id === id);
    picker.set(
      settings.providers.map((p) => ({ value: p.id, label: p.custom ? t("customProvider") : p.id })),
      id,
    );
    $("model-name").value = id === settings.selected && settings.model ? settings.model : item.model;
    $("base-url").value = item.baseUrl;
    $("base-url").readOnly = !item.custom;
    $("api-key").value = "";
    $("api-key").placeholder = item.hasKey ? t("keyStored") : t("keyOptional");
    $("reset-model").hidden = !settings.overridden;
    $("model-error").textContent = "";
  }
  $("model-settings").onclick = async () => {
    try {
      settings = await api("model");
      show(settings.selected);
      dialog.showModal();
    } catch (e) {
      notice(e.message);
    }
  };
  $("model-close").onclick = () => dialog.close();
  dialog.onclose = () => {
    $("api-key").value = "";
    picker.close();
  };
  $("base-url").oninput = () => {
    const item = settings.providers.find((p) => p.id === id);
    $("api-key").placeholder =
      item.hasKey && item.baseUrl === $("base-url").value.trim() ? t("keyStored") : t("keyOptional");
  };
  async function save(body) {
    const confirm = $("save-model");
    confirm.disabled = true;
    try {
      await api("model", body);
      dialog.close();
      notice(t("modelSaved"));
    } catch (e) {
      $("model-error").textContent = e.message;
    } finally {
      confirm.disabled = false;
    }
  }
  $("model-form").onsubmit = (e) => {
    e.preventDefault();
    save({ id, model: $("model-name").value, baseUrl: $("base-url").value, key: $("api-key").value });
  };
  $("reset-model").onclick = () => save({ reset: true });
}
