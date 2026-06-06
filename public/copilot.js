// Student Signal Copilot — Challenge 02 front-end.
// Streams the multi-agent pipeline over SSE and renders the full output.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const pretty = (s) => cap(String(s ?? "").replace(/_/g, " "));

// Agents in display order (matches the architecture diagram).
const AGENTS = [
  { key: "Extraction", desc: "Plain text → structured fields" },
  { key: "Grounding", desc: "Match to real CriticalAsset assets" },
  { key: "PublicData", desc: "NYC DOB / 311 lookup" },
  { key: "Enrichment", desc: "Public + asset data → operational meaning" },
  { key: "Compliance", desc: "Obligations · escalation" },
  { key: "Review", desc: "Confidence labels · flag gaps" },
  { key: "Debate", desc: "Root-cause debate (only if uncertain)" },
  { key: "Recommendation", desc: "Next best action · closure question" },
];

const SAMPLES = [
  { label: "🚽 Sewage smell (recurring)", text: "The second-floor bathroom by the gym smells like sewage again and the floor is wet near the drain. It has been like this since Monday.", stillHappening: true, whoAffected: "Students and staff on 2nd floor" },
  { label: "🥵 Hot classroom", text: "Room 304 is unbearable after 11am three days in a row. Kids are getting headaches and the teacher props the hallway door open.", stillHappening: true, whoAffected: "One classroom of students + teacher" },
  { label: "🚪 Exit door won't latch", text: "The stairwell exit door on the 3rd floor doesn't latch shut anymore, it just swings open.", stillHappening: true },
  { label: "💡 Flickering lights", text: "The lights in the main corridor keep flickering and one panel area smells a bit warm.", stillHappening: true },
];

const LABEL_CLASS = { Verified: "lbl-verified", Likely: "lbl-likely", Inferred: "lbl-inferred", Missing: "lbl-missing", "Needs inspection": "lbl-inspect" };

const shortModel = (m) => String(m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-4-\d$/, (x) => x); // e.g. haiku-4-5
const modelTag = (m) => (!m || m === "rule" ? "rule" : /haiku/.test(m) ? "haiku" : /sonnet/.test(m) ? "sonnet" : /opus/.test(m) ? "opus" : "claude");

let currentRecord = null;

// ---------- init ----------
async function init() {
  const health = await fetch("/api/health").then((r) => r.json()).catch(() => null);
  const llm = $("#llm");
  if (health?.llm?.enabled) {
    llm.className = "conn conn--ok";
    llm.textContent = `${shortModel(health.llm.heavy)} (overview) · ${shortModel(health.llm.light)} (specialists)`;
  } else { llm.className = "conn conn--warn"; llm.textContent = "stub mode (no key)"; }

  $("#samples").innerHTML = SAMPLES.map((s, i) => `<button class="sample" data-i="${i}">${esc(s.label)}</button>`).join("");
  $("#samples").querySelectorAll(".sample").forEach((b) =>
    b.addEventListener("click", () => {
      const s = SAMPLES[b.dataset.i];
      $("#text").value = s.text;
      $("#locationHint").value = "";
      $("#whoAffected").value = s.whoAffected ?? "";
      $("#stillHappening").checked = s.stillHappening !== false;
    })
  );

  $("#submit").addEventListener("click", submit);
  $("#run-overview").addEventListener("click", runOverview);
  loadInbox();
}

// ---------- meta-overview agent (cross-signal) ----------
async function runOverview() {
  const box = $("#overview");
  box.innerHTML = `<p class="muted small">Overview agent watching across all signals…</p>`;
  try {
    const o = await fetch("/api/overview").then((r) => r.json());
    if (!o.patterns?.length && !o.portfolioSummary) { box.innerHTML = `<p class="muted small">No signals yet.</p>`; return; }
    box.innerHTML = `
      <div class="ov-summary">${esc(o.portfolioSummary)}</div>
      ${o.urgentIds?.length ? `<div class="ov-urgent">🔺 ${o.urgentIds.length} signal(s) surfaced as URGENT</div>` : ""}
      ${(o.patterns || []).map((p) => `<div class="ov-pattern">
        <div class="ov-title">${esc(p.title)} <span class="muted small">· ${p.recordIds.length} reports</span></div>
        <div class="muted small">${esc(p.insight)}</div>
        <div class="ov-rec">→ ${esc(p.recommendation)}</div>
      </div>`).join("")}
      <div class="src src-${modelTag(o.model)}" style="margin-top:8px">${modelTag(o.model)} · cross-signal</div>`;
  } catch {
    box.innerHTML = `<p class="muted small">Overview failed.</p>`;
  }
}

// ---------- submit + stream ----------
function submit() {
  const text = $("#text").value.trim();
  if (!text) { $("#text").focus(); return; }

  const params = new URLSearchParams({ text });
  if ($("#locationHint").value.trim()) params.set("locationHint", $("#locationHint").value.trim());
  if ($("#whoAffected").value.trim()) params.set("whoAffected", $("#whoAffected").value.trim());
  params.set("stillHappening", $("#stillHappening").checked ? "true" : "false");
  if ($("#hasPhoto").checked) params.set("photoName", "field-photo.jpg");

  $("#empty-state").hidden = true;
  $("#result").hidden = true;
  $("#result").innerHTML = "";
  $("#pipeline").hidden = false;
  renderPipelineSkeleton();
  $("#submit").disabled = true;
  $("#submit").textContent = "Agents working…";

  const es = new EventSource(`/api/signal/stream?${params.toString()}`);
  es.addEventListener("start", () => markActive(0));
  es.addEventListener("step", (e) => onStep(JSON.parse(e.data)));
  es.addEventListener("done", (e) => { onDone(JSON.parse(e.data)); es.close(); });
  es.addEventListener("error", () => {
    $("#submit").disabled = false; $("#submit").textContent = "Submit signal →";
    es.close();
  });
}

function renderPipelineSkeleton() {
  $("#pipeline-nodes").innerHTML = AGENTS.map(
    (a) => `<li class="pnode" data-agent="${a.key}">
      <span class="pdot"></span>
      <div class="pbody"><span class="pname">${esc(a.key)}</span><span class="pdesc">${esc(a.desc)}</span></div>
      <span class="pmeta"></span>
    </li>`
  ).join("");
}
function markActive(idx) {
  const nodes = $("#pipeline-nodes").children;
  if (nodes[idx]) nodes[idx].classList.add("active");
}
function onStep(step) {
  const li = $(`.pnode[data-agent="${step.agent}"]`);
  if (li) {
    li.classList.remove("active");
    li.classList.add(step.ran ? "done" : "skipped");
    li.querySelector(".pmeta").innerHTML = step.ran
      ? `<span class="src src-${modelTag(step.model)}">${modelTag(step.model)}</span><span class="ms">${(step.ms / 1000).toFixed(1)}s</span>`
      : `<span class="ms">skipped</span>`;
    li.title = step.reason;
  }
  // light up the next pending node
  const next = [...$("#pipeline-nodes").children].find((n) => !n.classList.contains("done") && !n.classList.contains("skipped") && !n.classList.contains("active"));
  if (next) next.classList.add("active");
}

function onDone(record) {
  currentRecord = record;
  $("#submit").disabled = false;
  $("#submit").textContent = "Submit signal →";
  renderResult(record);
  $("#result").hidden = false;
  loadInbox();
}

// ---------- render full result ----------
function renderResult(r) {
  const i = r.issue, rec = r.recommendation, rev = r.review, c = r.compliance;
  const totalMs = r.trace.reduce((s, t) => s + t.ms, 0);

  $("#result").innerHTML = `
    ${r.urgent ? `<div class="urgent-banner">🔺 URGENT — ${esc(r.urgentReason)}</div>` : ""}
    ${c.escalate ? `<div class="escalate-banner">⚠ Escalate — ${esc(c.escalationReason)}</div>` : ""}

    <div class="res-head">
      <div>
        <h2>${esc(rec.cleanedWorkOrderTitle)}</h2>
        <p class="muted small">from signal: "${esc(r.signal.text)}"</p>
      </div>
      <div class="res-badges">
        ${r.urgent ? `<span class="badge sev-critical">URGENT</span>` : ""}
        <span class="badge sev-${rec.severity}">${cap(rec.severity)}</span>
        <span class="badge sev-unknown">${esc(pretty(i.category))}</span>
        <span class="src src-${r.llmSource}">${(totalMs / 1000).toFixed(1)}s</span>
      </div>
    </div>

    <!-- structured issue chips -->
    <div class="chips">
      <span class="chip"><b>Location</b> ${esc(i.location)}</span>
      <span class="chip"><b>Urgency</b> ${esc(i.urgency)}</span>
      <span class="chip"><b>Recurring</b> ${i.recurring ? "Yes" : "No"}</span>
      <span class="chip"><b>Affected</b> ${esc(i.affectedUsers)}</span>
    </div>

    ${section("Confidence ledger", "Each claim labeled by how well it's grounded — the field observation is the only thing marked Verified.", `
      <table class="ledger">
        ${rev.claims.map((cl) => `<tr>
          <td><span class="lbl ${LABEL_CLASS[cl.label] || "lbl-inferred"}">${esc(cl.label)}</span></td>
          <td><div>${esc(cl.statement)}</div><div class="muted small">${esc(cl.basis)}</div></td>
        </tr>`).join("")}
      </table>
      ${rev.missingEvidence.length ? `<div class="missing"><b>Missing evidence:</b> ${rev.missingEvidence.map(esc).join(" · ")}</div>` : ""}
      <div class="muted small">Overall confidence: <b>${esc(rev.overallConfidence)}</b></div>
    `)}

    ${r.debate ? section("Root-cause debate", "Triggered because the review flagged the root cause as uncertain.", `
      <div class="debate-q">${esc(r.debate.question)}</div>
      ${r.debate.positions.map((p, n) => `<div class="debate-pos"><span class="hyp">Hypothesis ${n + 1}</span> <b>${esc(p.hypothesis)}</b><div class="muted small">${esc(p.argument)}</div></div>`).join("")}
      <div class="debate-res">→ ${esc(r.debate.resolution)}</div>
    `) : ""}

    ${section(`Asset grounding · ${r.assetMatches.length} match${r.assetMatches.length === 1 ? "" : "es"}`, "Anchored to real CriticalAsset equipment — not invented.", `
      ${r.assetMatches.length ? r.assetMatches.map((m) => `<div class="asset-item">
        <div class="a-name">${esc(m.name)} <span class="muted small">${m.product ? esc(m.product) : ""} · match ${Math.round(m.score * 100)}%</span></div>
        <div class="a-meta">${esc(m.locationAddress || "")}</div>
        ${m.troubleshooting ? `<details class="sop"><summary>Documented troubleshooting (SOP)</summary><pre>${esc(m.troubleshooting.slice(0, 600))}</pre></details>` : ""}
      </div>`).join("") : `<p class="muted">No confident asset match — flagged as Needs inspection.</p>`}
    `)}

    ${section("Enrichment · operational meaning", "Public + asset data translated into what it means for the fix.", `
      <p>${esc(r.enrichment.operationalMeaning)}</p>
      ${r.enrichment.publicData.length ? r.enrichment.publicData.map((p) => `<div class="pubref">
        <span class="pubsrc">${esc(p.source)}${p.count != null ? ` · ${p.count}` : ""}</span>
        <span>${esc(p.finding)}</span>
        ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">↗</a>` : ""}
      </div>`).join("") : `<p class="muted small">No public records retrievable for this run; enrichment stands on asset history.</p>`}
    `)}

    ${section("Compliance & obligations", "What the issue touches before anyone closes it.", `
      ${c.obligations.length ? `<ul class="oblist">${c.obligations.map((o) => `<li><b>${esc(o.title)}</b>${o.cadence ? ` <span class="cadence">${esc(o.cadence)}</span>` : ""}<div class="muted small">${esc(o.basis)}</div></li>`).join("")}</ul>` : `<p class="muted small">No specific obligations matched.</p>`}
    `)}

    ${section("Recommended workflow", "What an operator does Monday morning.", `
      <div class="recmeta"><span class="chip"><b>Assign to</b> ${esc(rec.assignmentGroup)}</span></div>
      <ol class="nextactions">${rec.nextActions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>
      ${rec.missingEvidenceChecklist.length ? `<div class="missing"><b>Evidence checklist:</b> ${rec.missingEvidenceChecklist.map(esc).join(" · ")}</div>` : ""}
    `)}

    <!-- closure loop -->
    <div class="closure card">
      <h3>Close the loop with the student</h3>
      <p class="student-msg">"${esc(rec.studentStatusMessage)}"</p>
      <div class="closure-q muted small">${esc(rec.closureQuestion)}</div>
      <div id="verify-zone"></div>
    </div>

    ${section("Supervisor trace", "Every routing decision, auditable.", `
      <table class="tracetbl">${r.trace.map((t) => `<tr class="${t.ran ? "" : "trace-skip"}">
        <td>${esc(t.agent)}</td>
        <td>${t.ran ? `<span class="src src-${modelTag(t.model)}">${modelTag(t.model)}</span>` : `<span class="muted small">skipped</span>`}</td>
        <td class="muted small">${esc(t.reason)}</td>
        <td class="ms">${t.ran ? (t.ms / 1000).toFixed(1) + "s" : ""}</td>
      </tr>`).join("")}</table>
    `)}
  `;

  renderVerify(r);
  $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function section(title, sub, body) {
  return `<div class="res-section">
    <div class="res-section-head"><h3>${esc(title)}</h3><span class="muted small">${esc(sub)}</span></div>
    ${body}
  </div>`;
}

// ---------- verification loop ----------
function renderVerify(r) {
  const zone = $("#verify-zone");
  const v = r.verification;
  if (v.status && v.status !== "pending") {
    const reopened = v.status !== "fixed";
    zone.innerHTML = `<div class="verify-result ${reopened ? "reopened" : "closed"}">
      ${reopened ? "🔁 Reopened" : "✅ Closed"} — reporter said: <b>${esc(v.status.replace(/_/g, " "))}</b>
      ${r._decision ? `<div class="muted small">${esc(r._decision)}</div>` : ""}
    </div>`;
    return;
  }
  zone.innerHTML = `<div class="verify-btns">
    <button class="vbtn vfixed" data-s="fixed">✅ It's fixed</button>
    <button class="vbtn vstill" data-s="still_happening">⚠ Still happening</button>
    <button class="vbtn vworse" data-s="worse">🔺 It's worse</button>
  </div>`;
  zone.querySelectorAll(".vbtn").forEach((b) =>
    b.addEventListener("click", () => verify(r.id, b.dataset.s))
  );
}

async function verify(id, status) {
  const zone = $("#verify-zone");
  zone.innerHTML = `<div class="muted small">Verification agent following up…</div>`;
  const out = await fetch(`/api/signals/${id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }).then((r) => r.json());
  const reopened = out.decision.reopen;
  zone.innerHTML = `<div class="verify-result ${reopened ? "reopened" : "closed"}">
    ${reopened ? "🔁 Reopened" : "✅ Closed"} — ${esc(out.decision.message)}
  </div>`;
  loadInbox();
}

// ---------- inbox ----------
async function loadInbox() {
  const data = await fetch("/api/signals").then((r) => r.json()).catch(() => null);
  if (!data) return;
  const inbox = $("#inbox");
  if (!data.records.length) { inbox.innerHTML = `<li class="muted small">No signals yet.</li>`; return; }
  inbox.innerHTML = data.records.map((r) => `<li class="inbox-item ${r.urgent ? "is-urgent" : ""}" data-id="${r.id}">
    <div class="ix-top">
      <span>${r.urgent ? `<span class="badge sev-critical">URGENT</span> ` : ""}<span class="badge sev-${r.severity}">${cap(r.severity)}</span></span>
      <span class="vstatus vs-${r.verification}">${r.verification === "pending" ? "open" : r.verification.replace(/_/g, " ")}</span>
    </div>
    <div class="ix-text">${esc(r.text.slice(0, 70))}${r.text.length > 70 ? "…" : ""}</div>
    <div class="muted small">${esc(pretty(r.category))} · ${esc(r.location)} ${r.escalate ? "· ⚠ escalated" : ""}</div>
  </li>`).join("");
  inbox.querySelectorAll(".inbox-item").forEach((li) =>
    li.addEventListener("click", () => openRecord(li.dataset.id))
  );
}

async function openRecord(id) {
  const r = await fetch(`/api/signals/${id}`).then((x) => x.json());
  $("#empty-state").hidden = true;
  $("#pipeline").hidden = true;
  renderResult(r);
  $("#result").hidden = false;
}

init();
