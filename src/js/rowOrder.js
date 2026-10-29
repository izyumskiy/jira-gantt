// Ручной порядок строк внутри группы: исполнители эпика на «По эпикам», истории эпика на «Эпик —
// история». Строка тащится за ручку ⋮⋮ и бросается только среди строк своей группы. Строки блока
// (строка и её заметка) несут data-cgroup / data-ckey; ручка — у первой строки блока.
import { t } from "./i18n.js";

let drag = null; // { group, key } — что сейчас тащат

// Порядок списка по сохранённым ключам; новые (не из порядка) — в конце в прежнем порядке.
export function applyOrder(list, order, keyOf) {
  if (!Array.isArray(order) || !order.length) return list;
  const pos = new Map(order.map((k, i) => [k, i]));
  const at = (x) => (pos.has(keyOf(x)) ? pos.get(keyOf(x)) : Infinity);
  return list.map((x, i) => ({ x, i })).sort((a, b) => at(a.x) - at(b.x) || a.i - b.i).map((y) => y.x);
}

// key встаёт сразу после afterKey (null — в начало).
export function moveKey(keys, key, afterKey) {
  const rest = keys.filter((k) => k !== key);
  const i = afterKey == null ? 0 : rest.indexOf(afterKey) + 1;
  rest.splice(i, 0, key);
  return rest;
}

export function mark(tr, group, key) {
  tr.dataset.cgroup = group;
  tr.dataset.ckey = key;
}

export function handle(group, key, label) {
  const h = document.createElement("button");
  h.className = "drag-handle row-handle";
  h.type = "button";
  h.textContent = "⋮⋮";
  h.draggable = true;
  h.title = t("order.rowHandle");
  h.setAttribute("aria-label", t("order.handleAria", { name: label }));
  h.ondragstart = (e) => {
    e.stopPropagation();
    drag = { group, key };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key);
  };
  h.ondragend = () => {
    drag = null;
  };
  return h;
}

const clear = (tbody) => tbody.querySelectorAll(".drop-before, .drop-after").forEach((r) => r.classList.remove("drop-before", "drop-after"));

// onMove(group, keys) — новый порядок ключей группы (как на экране после переноса).
export function wire(tbody, onMove) {
  let drop = null;
  const rowsOf = (group, key) => [...tbody.querySelectorAll("tr[data-cgroup]")].filter((r) => r.dataset.cgroup === group && (key == null || r.dataset.ckey === key));
  const keysOf = (group) => [...new Set(rowsOf(group).map((r) => r.dataset.ckey))];
  tbody.addEventListener("dragover", (e) => {
    if (!drag) return;
    const row = e.target.closest("tr[data-cgroup]");
    if (!row || row.dataset.cgroup !== drag.group) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const block = rowsOf(drag.group, row.dataset.ckey);
    const top = block[0].getBoundingClientRect().top;
    const bottom = block[block.length - 1].getBoundingClientRect().bottom;
    const before = e.clientY < (top + bottom) / 2;
    const keys = keysOf(drag.group);
    const idx = keys.indexOf(row.dataset.ckey);
    drop = { afterKey: before ? (idx > 0 ? keys[idx - 1] : null) : row.dataset.ckey };
    clear(tbody);
    (before ? block[0] : block[block.length - 1]).classList.add(before ? "drop-before" : "drop-after");
  });
  tbody.addEventListener("dragleave", (e) => {
    if (!tbody.contains(e.relatedTarget)) clear(tbody);
  });
  tbody.addEventListener("drop", (e) => {
    if (!drag || !drop) return;
    e.preventDefault();
    e.stopPropagation();
    const { group, key } = drag;
    const keys = keysOf(group);
    const next = moveKey(keys, key, drop.afterKey);
    drag = null;
    drop = null;
    clear(tbody);
    if (next.join("\u0001") !== keys.join("\u0001")) onMove(group, next);
  });
}
