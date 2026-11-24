import { createHttpProvider } from "@codesoul-co/ditto/worker/infer/providers";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";

const presets = {
  openai: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  deepseek: { kind: "openai-compatible", baseUrl: "https://api.deepseek.com" },
  anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  gemini: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
};
const custom = "@custom";
export function createModelSettings(config) {
  const known = { ...presets, ...config.providers };
  const edits = new Map();
  let selected = config.model?.provider;
  let active;
  function activate(id, settings, model, network) {
    const provider = createHttpProvider({
      ...settings,
      sandbox: new Sandbox(config.workspace, { network }),
      timeoutMs: 120_000,
    });
    active = { provider, model: { provider: id === custom ? "custom" : id, model } };
    selected = id;
  }
  function reset() {
    edits.clear();
    active = undefined;
    selected = config.model?.provider;
    if (selected) activate(selected, known[selected], config.model.model, config.sandbox.network);
  }
  reset();
  function snapshot() {
    const providers = [...Object.keys(known), custom].map((id) => {
      const data = edits.get(id) || known[id] || {};
      return {
        id,
        baseUrl: data.baseUrl || "",
        model: data.model || (id === config.model?.provider ? config.model.model : "") || "",
        hasKey: Boolean(data.apiKey),
        custom: id === custom,
      };
    });
    return {
      providers,
      selected: selected || providers[0].id,
      model: active?.model.model || "",
      overridden: edits.size > 0,
    };
  }
  function update(body, t) {
    if (body.reset === true) {
      reset();
      return snapshot();
    }
    const { id } = body;
    if (typeof id !== "string" || !(Object.hasOwn(known, id) || id === custom))
      throw new Error(t("providerInvalid"));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model || model.length > 256) throw new Error(t("modelRequired"));
    const prior = edits.get(id) || known[id];
    let baseUrl = prior?.baseUrl;
    if (id === custom) {
      let url;
      try {
        url = new URL(body.baseUrl);
      } catch {
        throw new Error(t("endpointInvalid"));
      }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        !(url.protocol === "https:" || (local && url.protocol === "http:")) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(t("endpointInvalid"));
      baseUrl = url.href.replace(/\/$/, "");
    }
    if (typeof body.key !== "string" || body.key.length > 8192 || /[\r\n]/.test(body.key))
      throw new Error(t("keyInvalid"));
    // A secret belongs to its endpoint. Changing the custom URL never carries the old key across.
    const apiKey = body.key.trim() || (prior?.baseUrl === baseUrl ? prior.apiKey : undefined);
    const settings = {
      ...prior,
      kind: id === custom ? "openai-compatible" : prior.kind,
      baseUrl,
      apiKey,
      model,
    };
    activate(id, settings, model, [new URL(baseUrl).origin]);
    edits.set(id, settings);
    return snapshot();
  }
  return {
    snapshot,
    update,
    get active() {
      return active;
    },
  };
}
