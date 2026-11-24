import { el, icon } from "./canvas.js";
import { nextName } from "./structure.js";

const $ = (id) => document.getElementById(id);

export function createContextMenu() {
  const menu = $("canvas-menu");
  let anchor;
  function close() {
    menu.hidden = true;
  }
  function open({ x, y, element }, title, actions) {
    anchor = element;
    menu.setAttribute("aria-label", title);
    const heading = el("div", "menu-heading", title);
    menu.replaceChildren(
      heading,
      ...actions.map(([label, run]) => {
        const button = el("button", "", label);
        button.setAttribute("role", "menuitem");
        button.onclick = () => {
          close();
          anchor.focus({ preventScroll: true });
          run();
        };
        return button;
      }),
    );
    menu.hidden = false;
    menu.style.left = Math.max(6, Math.min(x, innerWidth - menu.offsetWidth - 6)) + "px";
    menu.style.top = Math.max(6, Math.min(y, innerHeight - menu.offsetHeight - 6)) + "px";
    menu.querySelector("button").focus({ preventScroll: true });
  }
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target)) close();
  });
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  document.addEventListener("wheel", close, { passive: true });
  menu.onkeydown = (e) => {
    if (e.key === "Escape" || e.key === "Tab") {
      close();
      anchor?.focus({ preventScroll: true });
      if (e.key === "Escape") e.preventDefault();
      return;
    }
    const buttons = [...menu.querySelectorAll("button")];
    const i = buttons.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };
  return { open, close };
}

export function initCanvasLibrary({ t, state, list, select, create, clear, remove, guard, notice }) {
  const library = $("canvas-library"),
    dialog = $("canvas-dialog");
  let clearing, revision, deletion;
  const confirmDelete = $("history-delete");
  function openHistory() {
    if (!state().id) return;
    $("history-error").textContent = "";
    const date = new Intl.DateTimeFormat(document.documentElement.lang, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    $("history-list").replaceChildren(
      ...list().map((record) => {
        const row = el("button", "history-entry");
        const text = el("span", "history-name");
        text.append(
          el("strong", "", record.filename),
          el("small", "", record.definition.id + " · " + date.format(record.updated)),
        );
        row.append(icon("file"), text);
        if (record.id === state().id) {
          row.setAttribute("aria-current", "true");
          row.append(el("small", "current-canvas", t("currentCanvas")));
        }
        row.onclick = async () => {
          try {
            if (record.id !== state().id) await select(record.id);
            library.close();
          } catch (e) {
            $("history-error").textContent = e.message;
          }
        };
        const entry = el("div", "history-row");
        const del = el("button", "history-delete", t("deleteCanvas"));
        del.setAttribute("aria-label", t("deleteCanvasName", { name: record.filename }));
        del.onclick = () => {
          deletion = record.id;
          $("history-delete-description").textContent = t("deleteCanvasDescription", {
            name: record.filename,
          });
          $("history-delete-error").textContent = "";
          confirmDelete.showModal();
          $("history-delete-cancel").focus();
        };
        entry.append(row, del);
        return entry;
      }),
    );
    if (!library.open) library.showModal();
  }
  $("history-delete-cancel").onclick = () => confirmDelete.close();
  $("history-delete-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("history-delete-confirm");
    if (button.disabled) return;
    button.disabled = true;
    try {
      await remove(deletion);
      confirmDelete.close();
      openHistory();
      $("history-list").querySelector("button")?.focus();
    } catch (error) {
      $("history-delete-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  function promptCanvas(isClear, proposedName) {
    try {
      guard();
    } catch (e) {
      if (library.open) $("history-error").textContent = e.message;
      else notice(e.message);
      return;
    }
    library.close();
    clearing = isClear;
    revision = state().rev;
    $("canvas-title").textContent = t(clearing ? "clearCanvas" : "newCanvas");
    $("canvas-confirm").textContent = t(clearing ? "clearConfirm" : "newCanvas");
    $("canvas-name-field").hidden = clearing;
    $("clear-description").hidden = !clearing;
    $("clear-description").textContent = t("clearDescription", { name: state().filename });
    $("canvas-name").value =
      proposedName ||
      nextName(
        "untitled",
        list().map((r) => r.definition.id),
      );
    $("canvas-error").textContent = "";
    dialog.showModal();
    if (clearing) $("canvas-back").focus();
    else $("canvas-name").select();
  }
  $("canvas-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
      guard();
      if (revision !== state().rev) throw new Error(t("resend"));
      if (clearing) clear();
      else await create($("canvas-name").value.trim());
      dialog.close();
    } catch (e) {
      $("canvas-error").textContent = e.message;
    }
  };
  $("canvases").onclick = openHistory;
  $("history-close").onclick = () => library.close();
  $("new-canvas").onclick = () => promptCanvas(false);
  $("clear-canvas").onclick = () => promptCanvas(true);
  $("canvas-back").onclick = $("canvas-cancel").onclick = () => dialog.close();
  return { openHistory, promptCanvas };
}
