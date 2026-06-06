/**
 * Supervisor agent — orchestrates the specialist agents.
 *
 * It is deliberately simple if-logic (not a heavyweight planner): for a bounded
 * "one building, one work order" problem that is the right altitude. The point
 * is that every routing decision is recorded in an auditable trace, satisfying
 * the rule that "AI output must be human-reviewable."
 *
 * Routing:
 *   Extraction → (ground to real assets) → Enrichment + Compliance
 *   → Review (confidence) → [Debate IFF review says root cause is uncertain]
 *   → Recommendation.
 */
import { getAssetsRich, type RichAsset } from "./criticalasset.js";
import { getPublicContext } from "./publicData.js";
import {
  matchAssets, extractionAgent, enrichmentAgent, reviewAgent, debateAgent,
  complianceAgent, recommendationAgent, overviewAgent,
} from "./agents.js";
import { nextId, list } from "./store.js";
import type { Signal, ProcessedRecord, TraceStep, Debate, Overview } from "./types.js";

// Cache the building's assets so we don't refetch on every signal.
let assetCache: { at: number; assets: RichAsset[] } | null = null;
async function assets(): Promise<RichAsset[]> {
  if (assetCache && Date.now() - assetCache.at < 5 * 60_000) return assetCache.assets;
  const { assets } = await getAssetsRich(200, 0);
  assetCache = { at: Date.now(), assets };
  return assets;
}

const BUILDING_ADDRESS = "40 Irving Place, New York, NY";

function now(): number {
  return Date.now();
}

export async function runPipeline(signal: Signal, onStep?: (s: TraceStep) => void): Promise<ProcessedRecord> {
  const trace: TraceStep[] = [];
  const record = (s: TraceStep) => { trace.push(s); onStep?.(s); };
  const step = async <T>(agent: string, reason: string, fn: () => Promise<{ result: T; source: "claude" | "stub"; model: string; tier?: "light" | "heavy" }>): Promise<T> => {
    const t0 = now();
    const { result, source, model, tier } = await fn();
    record({ agent, ran: true, reason, source, model, tier, ms: now() - t0 });
    return result;
  };

  // 1. Extraction — the one true sequential dependency at the head.
  const issue = await step("Extraction", "Every signal starts as plain text that must be structured.", () => extractionAgent(signal));

  // 2. Grounding (deterministic) + PublicData (network) — independent, run together.
  const tGround = now();
  const all = await assets();
  const assetMatches = matchAssets(issue, all);
  record({
    agent: "Grounding",
    ran: true,
    reason: assetMatches.length ? `Matched ${assetMatches.length} real CriticalAsset asset(s) to anchor the issue.` : "No confident asset match — downstream agents flag this as needing inspection.",
    source: "stub",
    model: "rule",
    ms: now() - tGround,
  });
  const tPub = now();
  const publicRefs = await getPublicContext(BUILDING_ADDRESS, issue.category);
  record({ agent: "PublicData", ran: true, reason: publicRefs.length ? `Pulled ${publicRefs.length} public source(s) (NYC DOB/311).` : "No public records retrievable; enrichment proceeds on asset history.", source: "stub", model: "rule", ms: now() - tPub });

  // 3. Enrichment ‖ Compliance ‖ Review — all depend only on grounding, so run concurrently.
  const [enrichment, compliance, review] = await Promise.all([
    step("Enrichment", "Translate matched assets + public data into operational meaning.", () => enrichmentAgent(issue, assetMatches, publicRefs)),
    step("Compliance", "Surface obligations the issue touches before any closure.", () => complianceAgent(issue, assetMatches)),
    step("Review", "Skeptical supervisor labels each claim's confidence and flags gaps.", () => reviewAgent(signal, issue, assetMatches)),
  ]);

  // 4. Debate (only if Review says root cause is uncertain) ‖ Recommendation — both ready now.
  let debate: Debate | null = null;
  const [debateResult, recommendation] = await Promise.all([
    review.rootCauseUncertain
      ? step("Debate", "Review flagged root cause as UNCERTAIN → run a root-cause debate to expose reasoning.", () => debateAgent(issue, assetMatches))
      : Promise.resolve(null).then((v) => { record({ agent: "Debate", ran: false, reason: "Root cause is clear enough — debate skipped to keep the trace lean.", source: "stub", model: "rule", ms: 0 }); return v; }),
    step("Recommendation", "Compose the cleaned, actionable work order + closure question.", () => recommendationAgent(signal, issue, assetMatches, review, compliance)),
  ]);
  debate = debateResult;

  const llmSource: "claude" | "stub" = trace.some((t) => t.source === "claude") ? "claude" : "stub";

  // Deterministic severity floor: if the Compliance agent escalated (a safety/regulatory
  // trigger), the issue is high severity by definition — don't let a model's softer
  // severity guess undersell it. This keeps the URGENT guarantee robust to model variance.
  if (compliance.escalate && (recommendation.severity === "low" || recommendation.severity === "medium")) {
    recommendation.severity = "high";
  }

  // Guaranteed URGENT tag (deterministic, not LLM-dependent): a high/critical issue that
  // is recurring and still happening can never silently sit in the backlog.
  const stillHappening = signal.stillHappening !== false;
  const urgent = (recommendation.severity === "high" || recommendation.severity === "critical") && issue.recurring && stillHappening;
  const urgentReason = urgent
    ? `${recommendation.severity} severity + recurring + still happening — guaranteed URGENT so it surfaces to the top.`
    : "Does not meet the URGENT guarantee (needs high/critical + recurring + still happening).";

  const rec: ProcessedRecord = {
    id: nextId("rec"),
    signal,
    issue,
    assetMatches,
    enrichment,
    review,
    debate,
    compliance,
    recommendation,
    trace,
    llmSource,
    urgent,
    urgentReason,
    verification: { status: "pending", history: [] },
    createdAt: new Date().toISOString(),
  };
  return rec;
}

// Meta-overview: the cross-signal watch. Runs the only heavy-model agent over the
// whole inbox and merges its result with the deterministic URGENT guarantee.
export async function runOverview(): Promise<Overview> {
  const records = list();
  if (!records.length) {
    return { portfolioSummary: "No signals yet.", urgentIds: [], patterns: [], model: "rule", source: "stub" };
  }
  const inputs = records.map((r) => ({
    id: r.id,
    text: r.signal.text,
    category: r.issue.category,
    location: r.issue.location,
    severity: r.recommendation.severity,
    recurring: r.issue.recurring,
    urgent: r.urgent,
    verification: r.verification.status,
    createdAt: r.createdAt,
  }));
  const { result, model, source } = await overviewAgent(inputs);
  // Union with the deterministic guarantee so nothing urgent is ever dropped.
  const guaranteed = records.filter((r) => r.urgent).map((r) => r.id);
  const urgentIds = [...new Set([...result.urgentIds, ...guaranteed])];
  return { ...result, urgentIds, model, source };
}
