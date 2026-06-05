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
  complianceAgent, recommendationAgent,
} from "./agents.js";
import { nextId } from "./store.js";
import type { Signal, ProcessedRecord, TraceStep, Debate } from "./types.js";

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
  const step = async <T>(agent: string, reason: string, fn: () => Promise<{ result: T; source: "claude" | "stub" }>): Promise<T> => {
    const t0 = now();
    const { result, source } = await fn();
    record({ agent, ran: true, reason, source, ms: now() - t0 });
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
    ms: now() - tGround,
  });
  const tPub = now();
  const publicRefs = await getPublicContext(BUILDING_ADDRESS, issue.category);
  record({ agent: "PublicData", ran: true, reason: publicRefs.length ? `Pulled ${publicRefs.length} public source(s) (NYC DOB/311).` : "No public records retrievable; enrichment proceeds on asset history.", source: "stub", ms: now() - tPub });

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
      : Promise.resolve(null).then((v) => { record({ agent: "Debate", ran: false, reason: "Root cause is clear enough — debate skipped to keep the trace lean.", source: "stub", ms: 0 }); return v; }),
    step("Recommendation", "Compose the cleaned, actionable work order + closure question.", () => recommendationAgent(signal, issue, assetMatches, review, compliance)),
  ]);
  debate = debateResult;

  const llmSource: "claude" | "stub" = trace.some((t) => t.source === "claude") ? "claude" : "stub";

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
    verification: { status: "pending", history: [] },
    createdAt: new Date().toISOString(),
  };
  return rec;
}
