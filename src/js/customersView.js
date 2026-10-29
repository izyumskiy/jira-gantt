// Экран «Бизнес-заказчики»: заказчики (постановщики эпиков) за последний год, их эпики — когда начали
// делать, когда перевели в «Готово», сколько эпик пробыл в бизнес-тесте — и сводка ожидания в БТ.
// Данные — та же выгрузка, по которой AI-анализ берёт срок приёмки (acceptance.load, раз в сутки).
import * as acceptance from "./acceptance.js";
import { el, maybeLink, browseUrl } from "./gantt.js";
import { t } from "./i18n.js";

const fmt = (ms) => (ms == null ? "—" : new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "2-digit" }));
const num = (v) => (v == null ? "—" : String(v));

function summaryLine(sm) {
  const parts = [t("cust.sumEpics", { n: sm.epics, done: sm.done })];
  parts.push(sm.bt ? t("cust.sumBt", { n: sm.bt, median: sm.btMedian, avg: sm.btAvg, max: sm.btMax }) : t("cust.sumNoBt"));
  if (sm.toDoneMedian != null) parts.push(t("cust.sumToDone", { median: sm.toDoneMedian }));
  if (sm.returned) parts.push(t("cust.sumReturned", { n: sm.returned }));
  if (sm.inBt) parts.push(t("cust.sumInBt", { n: sm.inBt, max: sm.inBtMax }));
  return parts.join(" · ");
}

function btCell(x) {
  if (x.btDays == null) return el("td", "num muted", "—");
  const td = el("td", "num" + (x.btNow != null ? " cust-now" : ""), x.btNow != null ? t("cust.btNow", { n: x.btDays }) : String(x.btDays));
  if (x.returned) td.append(el("span", "cust-ret", " ↺"));
  td.title = x.returned ? t("cust.returnedHint") : "";
  return td;
}

function customerBlock(g) {
  const box = el("section", "card cust");
  const head = el("div", "cust-head");
  head.append(el("h3", null, g.name || t("cust.noCustomer")), el("div", "cust-sum", summaryLine(g.summary)));
  box.append(head);
  const tbl = el("table", "cust-table");
  const hr = el("tr");
  for (const k of ["key", "status", "summary", "started", "done", "bt", "toDone"]) hr.append(el("th", k === "bt" || k === "toDone" ? "num" : null, t(`cust.col.${k}`)));
  tbl.append(hr);
  for (const x of g.epics) {
    const tr = el("tr");
    const key = el("td", "cust-key");
    key.append(maybeLink(x.key, browseUrl(x.key), "tip-link"));
    tr.append(key, el("td", "cust-status", x.status || "—"), el("td", "cust-title", x.summary), el("td", null, fmt(x.started)), el("td", null, fmt(x.done)), btCell(x), el("td", "num", num(x.days)));
    tbl.append(tr);
  }
  box.append(tbl);
  return box;
}

export async function render(page, { force = false, notify = () => {} } = {}) {
  page.textContent = "";
  const bar = el("div", "cust-bar");
  const refresh = el("button", null, t("cust.refresh"));
  const info = el("span", "muted small");
  bar.append(el("h2", null, t("cust.title")), refresh, info);
  const hint = el("div", "muted small cust-hint", t("cust.hint"));
  const list = el("div", "cust-list");
  page.append(bar, hint, list);
  refresh.onclick = () => render(page, { force: true, notify }).catch((e) => notify(e && e.message ? e.message : String(e)));
  list.append(el("div", "muted", t("cust.loading")));
  let items;
  try {
    items = await acceptance.load({ force, onPage: (n, total) => (list.firstChild.textContent = t("cust.loadingN", { n, total })) });
  } catch (e) {
    list.textContent = "";
    list.append(el("div", "status error", t("cust.error", { msg: e && e.message ? e.message : String(e) })));
    return;
  }
  const at = await acceptance.loadedAt();
  info.textContent = at ? t("cust.loadedAt", { at: new Date(at).toLocaleString() }) : "";
  const report = acceptance.customersReport(items);
  list.textContent = "";
  if (!report.length) {
    list.append(el("div", "muted", t("cust.empty")));
    return;
  }
  info.textContent += ` · ${t("cust.count", { customers: report.length, epics: report.reduce((n, g) => n + g.epics.length, 0) })}`;
  for (const g of report) list.append(customerBlock(g));
}
