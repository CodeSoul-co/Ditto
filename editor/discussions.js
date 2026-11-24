import { createPicker } from "./picker.js";
import { el, icon } from "./canvas.js";

const $ = (id) => document.getElementById(id);
const md = window.markdownit({ html: false, breaks: true }).disable("image");
const validateLink = md.validateLink;
md.validateLink = (url) => /^(https?:\/\/|mailto:|#)/i.test(url) && validateLink(url);
md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
function markdown(text) {
  const body = el("div", "markdown");
  body.innerHTML = md.render(text);
  return body;
}
function displayPrompt(prompt) {
  // A copied chat message may start with its timestamp on a separate line.
  return (prompt || "").replace(/^(?:[01]?\d|2[0-3]):[0-5]\d[ \t]*\r?\n(?:[ \t]*\r?\n)*(?=[ \t]*\S)/, "");
}
function attachmentView(file) {
  const details = el("details", "md-file");
  details.append(el("summary", "", file.name));
  details.ontoggle = () => {
    if (details.open && details.childElementCount === 1) details.append(markdown(file.text));
  };
  return details;
}
const chatPrefix = (key) => "ditto-discussions:v1:" + encodeURIComponent(key) + ":";
function fresh() {
  return { id: crypto.randomUUID(), created: Date.now(), draft: "", file: null, turns: [] };
}

export function createDiscussions({ t, notice, getGraph, recommend, request }) {
  let prefix,
    active,
    chats = new Map();
  const pending = new Set();
  function store(chat, documentPrefix = prefix) {
    try {
      // Distinct conversations and completed turns from another open tab should survive local edits.
      const key = documentPrefix + chat.id,
        stored = JSON.parse(localStorage.getItem(key));
      const turns = new Map((stored?.turns || []).map((turn) => [turn.id, turn]));
      for (const turn of chat.turns) {
        const prior = turns.get(turn.id);
        if (turn.answer || turn.error || !(prior?.answer || prior?.error)) turns.set(turn.id, turn);
      }
      chat.turns = [...turns.values()].sort((a, b) => a.time - b.time);
      localStorage.setItem(key, JSON.stringify(chat));
    } catch {
      notice(t("chatStoreFailed"));
    }
  }
  function select(chat) {
    active = chat;
    try {
      localStorage.setItem(prefix + "active", chat.id);
    } catch {
      /* The current selection still works. */
    }
    draw();
    $("messages").scrollTop = $("messages").scrollHeight;
  }
  function load(key) {
    prefix = chatPrefix(key);
    chats = new Map();
    let selected;
    try {
      selected = localStorage.getItem(prefix + "active");
      for (const name of Object.keys(localStorage).filter(
        (k) => k.startsWith(prefix) && k !== prefix + "active",
      )) {
        const chat = JSON.parse(localStorage.getItem(name));
        if (chat && typeof chat.id === "string" && Array.isArray(chat.turns)) chats.set(chat.id, chat);
      }
    } catch {
      notice(t("chatReadFailed"));
    }
    if (!chats.size) {
      const first = fresh();
      chats.set(first.id, first);
      store(first);
    }
    select(chats.get(selected) || [...chats.values()].at(-1));
  }
  function entry(label, body, role) {
    const article = el("article", "bubble " + role);
    article.append(el("small", "entry-author", label), body);
    return article;
  }
  function draw() {
    if (!active) return;
    const ordered = [...chats.values()].sort((a, b) => b.created - a.created);
    threadsPicker.set(
      ordered.map((chat) => {
        const title = displayPrompt(chat.turns[0]?.prompt) || chat.turns[0]?.file?.name || t("newChat");
        return { value: chat.id, label: title.split("\n")[0].slice(0, 65) };
      }),
      active.id,
    );
    $("prompt").value = active.draft || "";
    $("file-preview").replaceChildren();
    if (active.file) {
      const remove = el("button");
      remove.type = "button";
      remove.title = t("removeFile");
      remove.setAttribute("aria-label", remove.title);
      remove.append(icon("x"));
      remove.onclick = () => {
        active.file = null;
        store(active);
        draw();
      };
      $("file-preview").append(attachmentView(active.file), remove);
    }
    $("send").disabled = pending.has(active.id);
    $("suggestions").hidden = active.turns.length > 0;
    const entries = [];
    for (const turn of active.turns) {
      const user = entry(t("you") + " · " + turn.graph, markdown(displayPrompt(turn.prompt)), "user");
      if (turn.file) user.append(attachmentView(turn.file));
      const output = turn.answer
        ? markdown(turn.answer)
        : el("p", "entry-text", turn.error || (pending.has(active.id) ? t("reading") : t("interrupted")));
      const reply = entry(t(turn.applied ? "applied" : "response"), output, "assistant");
      if (turn.error) reply.classList.add("error");
      for (const type of turn.recommendations || []) {
        const b = recommend(type);
        if (b) reply.append(b);
      }
      entries.push(user, reply);
    }
    $("transcript").replaceChildren(...entries);
  }
  async function send(prompt) {
    if (!active || pending.has(active.id) || (!prompt && !active.file)) return;
    const chat = active,
      documentPrefix = prefix;
    const completed = chat.turns.filter((turn) => turn.answer);
    const recent = completed.length > 13 ? [completed[0], ...completed.slice(-12)] : completed;
    const history = recent.flatMap((turn) => [
      {
        role: "user",
        content: JSON.stringify({
          graph: turn.graph,
          request: turn.prompt,
          document: turn.file || undefined,
        }),
      },
      { role: "assistant", content: turn.answer },
    ]);
    const turn = { id: crypto.randomUUID(), time: Date.now(), graph: getGraph(), prompt, file: chat.file };
    chat.draft = "";
    chat.file = null;
    chat.turns.push(turn);
    pending.add(chat.id);
    store(chat);
    draw();
    $("messages").scrollTop = $("messages").scrollHeight;
    try {
      const result = await request({ prompt, history, attachment: turn.file }, () => active === chat);
      Object.assign(turn, {
        answer: result.message,
        applied: Boolean(result.definition),
        recommendations: result.recommendations,
      });
    } catch (e) {
      turn.error = e.message;
    } finally {
      pending.delete(chat.id);
      store(chat, documentPrefix);
      if (active === chat) {
        draw();
        $("messages").scrollTop = $("messages").scrollHeight;
      }
    }
  }
  const threadsPicker = createPicker($("threads"), (id) => select(chats.get(id)));
  $("new-chat").onclick = () => {
    if (!active) return;
    const next = fresh();
    chats.set(next.id, next);
    store(next);
    select(next);
    $("prompt").focus();
  };
  $("prompt").oninput = () => {
    if (active) {
      active.draft = $("prompt").value;
      store(active);
    }
  };
  $("attach").onclick = () => $("md-upload").click();
  $("md-upload").onchange = async (event) => {
    const file = event.target.files[0],
      chat = active,
      documentPrefix = prefix;
    event.target.value = "";
    if (!file || !chat) return;
    try {
      if (!/\.(md|markdown)$/i.test(file.name) || file.size > 32768) throw new Error(t("mdLimit"));
      chat.file = { name: file.name, text: await file.text() };
      store(chat, documentPrefix);
      if (active === chat) draw();
    } catch (e) {
      notice(e.message);
    }
  };
  function forget(key) {
    const removed = chatPrefix(key);
    try {
      for (const name of Object.keys(localStorage))
        if (name.startsWith(removed)) localStorage.removeItem(name);
    } catch {
      notice(t("chatStoreFailed"));
    }
  }
  return { load, draw, send, forget, hasPending: () => pending.size > 0 };
}
