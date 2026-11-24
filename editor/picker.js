import { el, icon } from "./canvas.js";

// The trigger keeps keyboard focus while aria-activedescendant follows the highlighted option.
export function createPicker(root, choose, signal) {
  const trigger = el("button", "picker-trigger"),
    label = el("span", "picker-label"),
    list = el("div", "picker-list");
  trigger.type = "button";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.dataset.aria = root.dataset.label;
  trigger.setAttribute("aria-label", root.getAttribute("aria-label"));
  list.id = root.id + "-list";
  list.setAttribute("role", "listbox");
  trigger.setAttribute("aria-controls", list.id);
  trigger.append(label, icon("chevron"));
  root.classList.add("picker");
  root.append(trigger, list);
  let entries = [],
    selected,
    highlight = -1,
    search = "",
    lastKey = 0;
  function close() {
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    search = "";
  }
  function move(index) {
    highlight = index;
    Array.from(list.children).forEach((row, i) => row.classList.toggle("highlight", i === index));
    const row = list.children[index];
    if (row) {
      trigger.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    }
  }
  function open() {
    if (!entries.length) return;
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    move(
      Math.max(
        0,
        entries.findIndex((e) => e.value === selected),
      ),
    );
  }
  function commit(index) {
    if (!entries[index]) return;
    close();
    trigger.focus();
    choose(entries[index].value);
  }
  function set(entriesNext, value) {
    close();
    entries = entriesNext;
    selected = value;
    const current = entries.find((e) => e.value === value);
    label.textContent = current?.label || "";
    trigger.title = label.textContent;
    list.replaceChildren(
      ...entries.map((entry, i) => {
        const row = el("div", "picker-item");
        row.id = list.id + "-" + i;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(entry.value === value));
        row.append(el("span", "", entry.label));
        if (entry.value === value) row.append(icon("check"));
        row.onmousedown = (event) => event.preventDefault();
        row.onclick = () => commit(i);
        return row;
      }),
    );
  }
  trigger.onclick = () => (list.hidden ? open() : close());
  trigger.onkeydown = (event) => {
    if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (list.hidden) open();
      else commit(highlight);
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (keys.includes(event.key)) {
      event.preventDefault();
      if (list.hidden) {
        open();
        if (event.key.startsWith("Arrow")) return;
      }
      move(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? entries.length - 1
            : Math.min(entries.length - 1, Math.max(0, highlight + (event.key === "ArrowUp" ? -1 : 1))),
      );
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (list.hidden) open();
      search = (Date.now() - lastKey < 800 ? search : "") + event.key.toLocaleLowerCase();
      lastKey = Date.now();
      const match = entries.findIndex((e) => e.label.toLocaleLowerCase().startsWith(search));
      if (match >= 0) move(match);
    }
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!root.contains(event.target)) close();
    },
    { signal },
  );
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) close();
  });
  close();
  return { set, close };
}
