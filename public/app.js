// Student Signal Copilot — Challenge 01 dashboard (vanilla JS).
// Talks ONLY to our own backend (/api/workorders); never to CriticalAsset directly.

const state = {
  orders: [],
  stats: null,
  filters: { search: "", stage: "", severity: "", category: "" },
  group: false,
};

const $ = (sel) => document.querySelector(sel);

// ---------- helpers ----------
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const prettyCat = (c) => (c || "").replace(/_/g, " ");

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function sevClass(s) { return `badge sev-${s || "unknown"}`; }

// ---------- data ----------
async function load() {
  const conn = $("#conn");
  conn.className = "conn conn--loading";
  conn.textContent = "loading…";
  try {
    const res = await fetch("/api/workorders");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const data = await res.json();
    state.orders = data.orders;
    state.stats = data.stats;
    conn.className = "conn conn--ok";
    conn.textContent = `live · ${data.totalCount} work orders`;
    hydrateFilters();
    render();
  } catch (err) {
    conn.className = "conn conn--err";
    conn.textContent = "error";
    $("#rows").innerHTML = `<tr><td colspan="8" class="empty">Failed to load: ${err.message}</td></tr>`;
  }
}

function hydrateFilters() {
  const uniq = (key) => [...new Set(state.orders.map((o) => o[key]).filter(Boolean))].sort();
  fillSelect("#f-stage", uniq("stage"));
  fillSelect("#f-severity", ["critical", "high", "medium", "low"].filter((s) => state.orders.some((o) => o.severity === s)));
  fillSelect("#f-category", uniq("category"), prettyCat);
}
function fillSelect(sel, values, label = (x) => x) {
  const el = $(sel);
  const first = el.options[0];
  el.innerHTML = "";
  el.appendChild(first);
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = cap(label(v));
    el.appendChild(opt);
  }
}

// ---------- filtering ----------
function visibleOrders() {
  const { search, stage, severity, category } = state.filters;
  const q = search.trim().toLowerCase();
  return state.orders
    .filter((o) => !stage || o.stage === stage)
    .filter((o) => !severity || o.severity === severity)
    .filter((o) => !category || o.category === category)
    .filter((o) => {
      if (!q) return true;
      const hay = [o.title, o.description, o.location.name, ...o.assets.map((a) => a.name)].join(" ").toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
}

// ---------- render ----------
function render() {
  renderCounters();
  renderTable();
  renderSidebar();
}

function renderCounters() {
  const s = state.stats;
  const cards = [
    { cls: "total", label: "Total work orders", value: s.total, sub: `${Object.keys(s.byCategory).length} categories` },
    { cls: "open", label: "Open", value: s.open, sub: `${s.inProgress} in progress` },
    { cls: "overdue", label: "Overdue", value: s.overdue, sub: "past due date" },
    { cls: "critical", label: "Critical", value: s.critical, sub: "needs attention" },
  ];
  $("#counters").innerHTML = cards
    .map(
      (c) => `<div class="counter counter--${c.cls}">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
        <div class="sub">${c.sub}</div>
      </div>`
    )
    .join("");
}

function rowHtml(o) {
  const asset = o.assets[0]?.name ?? "—";
  const extra = o.assets.length > 1 ? ` <span class="muted">+${o.assets.length - 1}</span>` : "";
  return `<tr data-id="${o.id}">
    <td>
      <div class="wo-title">${esc(o.title)}</div>
      <div class="wo-desc">${esc(o.description)}</div>
    </td>
    <td><span class="${sevClass(o.severity)}">${cap(o.severity)}</span></td>
    <td><span class="${sevClass(o.priority)}">${cap(o.priority)}</span></td>
    <td><span class="cat">${esc(prettyCat(o.category))}</span></td>
    <td>${esc(asset)}${extra}</td>
    <td>${esc(o.location.name)}</td>
    <td>${fmtDate(o.endDate)}${o.overdue ? '<span class="overdue-tag">OVERDUE</span>' : ""}</td>
    <td><span class="stage-pill"><span class="stage-dot" style="background:${o.stageColor || "#8b949e"}"></span>${esc(o.stage)}</span></td>
  </tr>`;
}

function renderTable() {
  const tbody = $("#rows");
  const orders = visibleOrders();
  $("#empty").hidden = orders.length > 0;

  if (!state.group) {
    tbody.innerHTML = orders.map(rowHtml).join("");
  } else {
    const groups = {};
    for (const o of orders) (groups[o.category] ??= []).push(o);
    tbody.innerHTML = Object.entries(groups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(
        ([cat, list]) =>
          `<tr class="group-row"><td colspan="8">${esc(prettyCat(cat))} · ${list.length}</td></tr>` +
          list.map(rowHtml).join("")
      )
      .join("");
  }

  tbody.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => openDrawer(tr.dataset.id))
  );
}

function renderSidebar() {
  const s = state.stats;
  const maxB = Math.max(1, ...s.topBuildings.map((b) => b.count));
  $("#top-buildings").innerHTML = s.topBuildings.length
    ? s.topBuildings.map((b) => barHtml(b.name, b.count, maxB)).join("")
    : '<li class="muted">No data</li>';

  const cats = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]);
  const maxC = Math.max(1, ...cats.map(([, n]) => n));
  $("#by-category").innerHTML = cats.map(([c, n]) => barHtml(prettyCat(c), n, maxC)).join("");
}
function barHtml(name, count, max) {
  return `<li>
    <div class="bar-head"><span class="name">${esc(name)}</span><span class="count">${count}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div>
  </li>`;
}

// ---------- drawer ----------
function openDrawer(id) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) return;
  const loc = o.location;
  const assetsHtml = o.assets.length
    ? o.assets
        .map(
          (a) => `<div class="asset-item">
            <div class="a-name">${esc(a.name || "Unnamed asset")}</div>
            <div class="a-meta">${a.status ? "Status: " + esc(a.status) + " · " : ""}${a.serialNumber ? "SN " + esc(a.serialNumber) : "no serial"}${a.lastServiceDate ? " · serviced " + fmtDate(a.lastServiceDate) : ""}</div>
          </div>`
        )
        .join("")
    : '<p class="muted">No linked assets.</p>';

  $("#drawer").innerHTML = `
    <button class="drawer-close" aria-label="Close">×</button>
    <h2>${esc(o.title)}</h2>
    <div class="d-badges">
      <span class="${sevClass(o.severity)}">Severity: ${cap(o.severity)}</span>
      <span class="${sevClass(o.priority)}">Priority: ${cap(o.priority)}</span>
      <span class="badge sev-unknown">${esc(cap(o.stage))}</span>
      ${o.overdue ? '<span class="badge sev-critical">Overdue</span>' : ""}
    </div>

    <div class="d-section">
      <h4>Description</h4>
      <p class="d-desc">${esc(o.description) || '<span class="muted">No description provided.</span>'}</p>
    </div>

    <div class="d-section">
      <h4>Details</h4>
      <dl class="d-grid">
        <dt>Category</dt><dd>${esc(cap(prettyCat(o.category)))}</dd>
        <dt>Type</dt><dd>${esc(cap(prettyCat(o.type || "—")))}</dd>
        <dt>Stage</dt><dd>${esc(o.stage)}</dd>
        <dt>Start</dt><dd>${fmtDate(o.startDate)}</dd>
        <dt>Due</dt><dd>${fmtDate(o.endDate)}</dd>
        <dt>Created</dt><dd>${fmtDate(o.createdAt)}</dd>
        <dt>Assignees</dt><dd>${o.assignmentCount}</dd>
      </dl>
    </div>

    <div class="d-section">
      <h4>Location</h4>
      <dl class="d-grid">
        <dt>Building</dt><dd>${esc(loc.name)}</dd>
        <dt>Address</dt><dd>${esc(loc.address) || "—"}</dd>
        ${loc.city || loc.state ? `<dt>City</dt><dd>${esc([loc.city, loc.state].filter(Boolean).join(", "))}</dd>` : ""}
      </dl>
    </div>

    <div class="d-section">
      <h4>Linked assets (${o.assets.length})</h4>
      ${assetsHtml}
    </div>`;

  $("#drawer").hidden = false;
  $("#overlay").hidden = false;
  $("#drawer").querySelector(".drawer-close").addEventListener("click", closeDrawer);
}
function closeDrawer() {
  $("#drawer").hidden = true;
  $("#overlay").hidden = true;
}

// ---------- util ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- events ----------
$("#search").addEventListener("input", (e) => { state.filters.search = e.target.value; renderTable(); });
$("#f-stage").addEventListener("change", (e) => { state.filters.stage = e.target.value; renderTable(); });
$("#f-severity").addEventListener("change", (e) => { state.filters.severity = e.target.value; renderTable(); });
$("#f-category").addEventListener("change", (e) => { state.filters.category = e.target.value; renderTable(); });
$("#group").addEventListener("change", (e) => { state.group = e.target.checked; renderTable(); });
$("#refresh").addEventListener("click", load);
$("#overlay").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

load();
