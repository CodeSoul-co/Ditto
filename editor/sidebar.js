export function initSidebar() {
  const main = document.querySelector("main");
  const panel = document.getElementById("sidebar");
  const grip = document.getElementById("resize-sidebar");
  const open = document.getElementById("open-sidebar");
  const close = document.getElementById("close-sidebar");
  const storageKey = "ditto-editor:sidebar";
  let width;
  let collapsed = main.clientWidth <= 540;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (typeof saved?.collapsed === "boolean") collapsed = saved.collapsed;
    if (Number.isFinite(saved?.width)) width = saved.width;
  } catch {
    /* Use session defaults when storage is unavailable. */
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ collapsed, width }));
    } catch {
      /* Session-only. */
    }
  }
  function size(requested) {
    const full = main.clientWidth;
    const max = full <= 540 ? Math.max(160, full - 24) : Math.min(800, full - 270);
    const min = Math.min(220, max);
    const initial = full <= 540 ? full * 0.82 : full <= 780 ? 240 : Math.max(310, Math.min(425, full * 0.28));
    const actual = Math.round(Math.max(min, Math.min(max, requested ?? initial)));
    main.style.setProperty("--sidebar-width", actual + "px");
    grip.setAttribute("aria-valuemin", min);
    grip.setAttribute("aria-valuemax", max);
    grip.setAttribute("aria-valuenow", actual);
    return actual;
  }
  function display() {
    main.classList.toggle("panel-closed", collapsed);
    panel.hidden = collapsed;
    open.hidden = !collapsed;
    open.setAttribute("aria-expanded", String(!collapsed));
    close.setAttribute("aria-expanded", String(!collapsed));
  }
  function toggle(value) {
    collapsed = value;
    display();
    save();
    (collapsed ? open : close).focus();
  }
  open.onclick = () => toggle(false);
  close.onclick = () => toggle(true);
  let drag;
  grip.onpointerdown = (event) => {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width };
    grip.setPointerCapture(event.pointerId);
    main.classList.add("resizing");
  };
  grip.onpointermove = (event) => {
    if (drag?.id === event.pointerId) width = size(drag.width + drag.x - event.clientX);
  };
  grip.onlostpointercapture = () => {
    drag = undefined;
    main.classList.remove("resizing");
    save();
  };
  grip.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = panel.getBoundingClientRect().width;
    width = size(
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? main.clientWidth
          : current + (event.key === "ArrowLeft" ? 20 : -20),
    );
    save();
  };
  new ResizeObserver(() => size(width)).observe(main);
  size(width);
  display();
}
