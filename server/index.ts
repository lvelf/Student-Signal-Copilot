/**
 * Express server.
 *   - Serves the dashboard (static files in /public)
 *   - Exposes /api/workorders and /api/assets, which proxy CriticalAsset
 *     server-side so credentials never reach the browser.
 */
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkOrders, getAssets, type RawWorkOrder } from "./criticalasset.js";
import { runPipeline } from "./pipeline.js";
import { verificationDecision } from "./agents.js";
import { save, get, list, nextId } from "./store.js";
import { llmInfo } from "./llm.js";
import type { Signal, VerificationStatus } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
const PORT = Number(process.env.PORT ?? 3000);

// ---------- Normalization ----------

/** CriticalAsset returns Unix-millisecond strings; turn them into ISO (or null). */
function toIso(ms: string | null): string | null {
  if (!ms) return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

const DONE_STAGES = ["done", "complete", "completed", "closed", "resolved"];

function normalizeWorkOrder(wo: RawWorkOrder) {
  const stage = wo.workOrderStage?.name ?? "Unknown";
  const isDone = DONE_STAGES.some((s) => stage.toLowerCase().includes(s));
  const endIso = toIso(wo.endDate);
  const overdue = !isDone && endIso != null && new Date(endIso).getTime() < Date.now();

  const assets = (wo.workOrderAssets ?? [])
    .map((wa) => wa.asset)
    .filter((a): a is NonNullable<typeof a> => a != null)
    .map((a) => ({ id: a.id, name: a.name, status: a.status, serialNumber: a.serialNumber, lastServiceDate: toIso(a.lastServiceDate) }));

  return {
    id: wo.id,
    title: wo.title ?? "(untitled)",
    description: wo.description ?? "",
    severity: wo.severity ?? "unknown",
    priority: wo.executionPriority ?? "unknown",
    type: wo.workOrderType ?? null,
    category: wo.workOrderServiceCategory ?? "general",
    stage,
    stageColor: wo.workOrderStage?.color_code ?? null,
    isDone,
    overdue,
    startDate: toIso(wo.startDate),
    endDate: endIso,
    createdAt: toIso(wo.createdAt),
    location: wo.location
      ? {
          id: wo.location.id,
          name: wo.location.locationName ?? wo.locationAddress ?? "Unknown",
          address: wo.location.address ?? wo.locationAddress ?? "",
          city: wo.location.city ?? "",
          state: wo.location.state ?? "",
        }
      : { id: null, name: wo.locationAddress ?? "Unknown", address: wo.locationAddress ?? "", city: "", state: "" },
    assets,
    assignmentCount: (wo.workOrderAssignments ?? []).length,
  };
}

export type WorkOrder = ReturnType<typeof normalizeWorkOrder>;

function buildStats(orders: WorkOrder[]) {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byLocation: Record<string, number> = {};
  let open = 0;
  let inProgress = 0;
  let overdue = 0;
  let critical = 0;

  for (const o of orders) {
    byCategory[o.category] = (byCategory[o.category] ?? 0) + 1;
    bySeverity[o.severity] = (bySeverity[o.severity] ?? 0) + 1;
    byLocation[o.location.name] = (byLocation[o.location.name] ?? 0) + 1;
    if (!o.isDone) open++;
    if (o.stage.toLowerCase().includes("progress")) inProgress++;
    if (o.overdue) overdue++;
    if (o.severity === "critical" || o.priority === "critical") critical++;
  }

  const topBuildings = Object.entries(byLocation)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { total: orders.length, open, inProgress, overdue, critical, byCategory, bySeverity, topBuildings };
}

// ---------- API routes ----------

app.get("/api/workorders", async (_req, res) => {
  try {
    const { nodes, totalCount } = await getWorkOrders(200, 0);
    const orders = nodes.map(normalizeWorkOrder);
    res.json({ totalCount, orders, stats: buildStats(orders) });
  } catch (err: any) {
    console.error("[/api/workorders]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/assets", async (_req, res) => {
  try {
    const { assets, total } = await getAssets(200, 0);
    res.json({ total, assets });
  } catch (err: any) {
    console.error("[/api/assets]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, llm: llmInfo }));

// ---------- Challenge 02: student signal → multi-agent pipeline ----------

// Submit a field observation; runs the full agent pipeline and stores the record.
app.post("/api/signal", async (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.text || typeof b.text !== "string" || !b.text.trim()) {
      return res.status(400).json({ error: "text (one-line observation) is required" });
    }
    const signal: Signal = {
      id: nextId("sig"),
      text: String(b.text).slice(0, 1000),
      locationHint: b.locationHint ? String(b.locationHint).slice(0, 200) : undefined,
      stillHappening: typeof b.stillHappening === "boolean" ? b.stillHappening : undefined,
      whoAffected: b.whoAffected ? String(b.whoAffected).slice(0, 200) : undefined,
      photoName: b.photoName ? String(b.photoName).slice(0, 200) : undefined,
      submittedAt: new Date().toISOString(),
    };
    const record = await runPipeline(signal);
    save(record);
    res.json(record);
  } catch (err: any) {
    console.error("[/api/signal]", err);
    res.status(500).json({ error: err.message });
  }
});

// Streaming variant — emits each agent step as it completes (Server-Sent Events),
// so the UI can light up the multi-agent pipeline live. EventSource uses GET.
app.get("/api/signal/stream", async (req, res) => {
  const text = String(req.query.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const signal: Signal = {
    id: nextId("sig"),
    text: text.slice(0, 1000),
    locationHint: req.query.locationHint ? String(req.query.locationHint).slice(0, 200) : undefined,
    stillHappening: req.query.stillHappening === "true" ? true : req.query.stillHappening === "false" ? false : undefined,
    whoAffected: req.query.whoAffected ? String(req.query.whoAffected).slice(0, 200) : undefined,
    photoName: req.query.photoName ? String(req.query.photoName).slice(0, 200) : undefined,
    submittedAt: new Date().toISOString(),
  };

  send("start", { signal, llm: llmInfo });
  try {
    const record = await runPipeline(signal, (s) => send("step", s));
    save(record);
    send("done", record);
  } catch (err: any) {
    console.error("[/api/signal/stream]", err);
    send("error", { error: err.message });
  }
  res.end();
});

// Operator inbox — list processed signals (compact).
app.get("/api/signals", (_req, res) => {
  res.json({
    llm: llmInfo,
    records: list().map((r) => ({
      id: r.id,
      text: r.signal.text,
      category: r.issue.category,
      severity: r.recommendation.severity,
      location: r.issue.location,
      escalate: r.compliance.escalate,
      overallConfidence: r.review.overallConfidence,
      verification: r.verification.status,
      llmSource: r.llmSource,
      createdAt: r.createdAt,
    })),
  });
});

// Full record with the complete agent trace.
app.get("/api/signals/:id", (req, res) => {
  const r = get(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

// Verification agent — student confirms reality; closes or reopens the loop.
app.post("/api/signals/:id/verify", (req, res) => {
  const r = get(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  const status = req.body?.status as VerificationStatus;
  if (!["fixed", "still_happening", "worse"].includes(status)) {
    return res.status(400).json({ error: "status must be fixed | still_happening | worse" });
  }
  const decision = verificationDecision(status as "fixed" | "still_happening" | "worse");
  r.verification.status = status;
  r.verification.history.push({ status, at: new Date().toISOString() });
  if (decision.reopen && decision.newSeverity) r.recommendation.severity = decision.newSeverity;
  save(r);
  res.json({ decision, record: r });
});

// ---------- Static dashboard ----------

const PUBLIC = path.join(__dirname, "..", "public");
app.get("/copilot", (_req, res) => res.sendFile(path.join(PUBLIC, "copilot.html")));
app.use(express.static(PUBLIC));

app.listen(PORT, () => {
  console.log(`\n  Student Signal Copilot — Challenge 01`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  API:        http://localhost:${PORT}/api/workorders\n`);
});
