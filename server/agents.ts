/**
 * The specialist agents (Challenge 02).
 *
 * Each agent is a focused function: a system prompt for Claude + a deterministic
 * stub grounded in real CriticalAsset data. The supervisor (pipeline.ts) decides
 * which agents run and in what order. Inspired by the AI co-scientist's
 * generate / reflect / ground / meta-review decomposition — minus the
 * tournament/evolution machinery, which is overkill for a bounded one-building,
 * one-work-order problem.
 */
import { complete, type CompleteResult } from "./llm.js";
import type { RichAsset } from "./criticalasset.js";
import type {
  Signal, StructuredIssue, AssetMatch, Obligation, Enrichment, PublicDataRef,
  Review, Claim, Debate, Compliance, Recommendation, Severity,
} from "./types.js";

// ============================================================
// Grounding — match the signal to real assets (no LLM needed)
// ============================================================

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  plumbing: ["sewage", "smell", "odor", "drain", "water", "wet", "leak", "toilet", "bathroom", "flush", "sink", "pipe", "faucet"],
  hvac: ["hot", "cold", "heat", "heating", "temperature", "air", "stuffy", "ac", "a/c", "ventilation", "warm", "freezing", "humid", "boiler", "radiator", "steam"],
  electrical: ["power", "outlet", "light", "lights", "flicker", "spark", "breaker", "shock", "panel", "switch", "outage"],
  fire_and_life_safety: ["exit", "alarm", "smoke", "fire", "extinguisher", "sprinkler", "egress", "latch", "emergency"],
  structural: ["crack", "ceiling", "wall", "floor", "roof", "collapse"],
  security: ["door", "lock", "camera", "access", "broken window"],
};

const CRITICAL_WORDS = ["sewage", "smoke", "fire", "spark", "flood", "flooding", "gas", "shock", "exposed", "collapse"];
const HIGH_WORDS = ["leak", "no heat", "broken", "weeks", "headache", "multiple", "spreading", "overflow"];
const RECUR_WORDS = ["again", "still", "since", "weeks", "recurring", "keeps", "every", "days", "repeatedly", "back"];

function detectCategory(text: string): string {
  const t = text.toLowerCase();
  let best = "general";
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

function detectSeverity(text: string, recurring: boolean): Severity {
  const t = text.toLowerCase();
  if (CRITICAL_WORDS.some((w) => t.includes(w))) return "critical";
  if (HIGH_WORDS.some((w) => t.includes(w))) return "high";
  return recurring ? "medium" : "low";
}

function detectLocation(signal: Signal): string {
  if (signal.locationHint) return signal.locationHint;
  const m = signal.text.match(/\b(room\s*\d+|\d+(?:st|nd|rd|th)\s*floor|basement|stairwell|gym|cafeteria|classroom|hallway|corridor|bathroom|restroom|roof)\b/i);
  return m ? m[0] : "Unspecified";
}

/** Score and return the top real assets matching the issue. */
export function matchAssets(issue: StructuredIssue, assets: RichAsset[], top = 3): AssetMatch[] {
  const kw = [...issue.likelyAssetKeywords, ...issue.issueType.split(/\s|_/)].map((w) => w.toLowerCase()).filter(Boolean);
  const loc = issue.location.toLowerCase();

  const scored = assets.map((a) => {
    const hay = `${a.name ?? ""} ${a.description ?? ""} ${a.product?.name ?? ""}`.toLowerCase();
    let score = 0;
    for (const w of kw) if (w.length > 2 && hay.includes(w)) score += 1;
    // category alignment via obligation trade
    const obs = parseObligations(a.obligations);
    if (obs.some((o) => o.trade === issue.category)) score += 1.5;
    // location alignment
    if (loc !== "unspecified" && (a.locationAddress ?? "").toLowerCase().includes(loc.replace(/room\s*/, ""))) score += 1;
    return { a, score, obs };
  });

  const max = Math.max(1, ...scored.map((s) => s.score));
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, top)
    .map(({ a, score, obs }) => ({
      id: a.id,
      name: a.name ?? "Unnamed asset",
      product: a.product?.name ?? null,
      locationAddress: a.locationAddress ?? null,
      score: Math.round((score / max) * 100) / 100,
      sop: pickInfo(a, "SOP"),
      troubleshooting: pickInfo(a, "Troubleshooting"),
      obligations: obs,
    }));
}

function pickInfo(a: RichAsset, key: string): string | null {
  const hit = (a.information ?? []).find((i) => (i.question ?? "").toLowerCase().includes(key.toLowerCase()));
  return hit ? hit.answer : null;
}

function parseObligations(raw: any[] | null): Obligation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => ({
    category: o.category ?? "unknown",
    trade: o.trade ?? null,
    cadence: o.cadence?.interval ?? null,
    tags: o.tags ?? [],
    roles: o.roles ?? [],
    tools: o.tools ?? [],
  }));
}

// ============================================================
// 1. Extraction agent  (≈ Generation)
// ============================================================

export async function extractionAgent(signal: Signal): Promise<CompleteResult<StructuredIssue>> {
  const system =
    "You are the Extraction agent in a building-operations pipeline. Turn a student's plain-English field observation into clean, structured operational data. Be conservative: only state what the text supports.";
  const prompt =
    `Field observation: "${signal.text}"\n` +
    (signal.locationHint ? `Location hint: ${signal.locationHint}\n` : "") +
    (signal.stillHappening != null ? `Still happening: ${signal.stillHappening}\n` : "") +
    (signal.whoAffected ? `Who is affected: ${signal.whoAffected}\n` : "") +
    `\nReturn JSON with keys: issueType, category (one of: hvac, electrical, plumbing, architectural, computers_and_telecom, fire_and_life_safety, landscape, security, structural, general), location, severity (low|medium|high|critical), urgency, recurring (boolean), affectedUsers, likelyAssetKeywords (array of 3-6 nouns to match equipment), summary (one clean sentence).`;

  return complete<StructuredIssue>({
    system,
    prompt,
    validate: (p) => ({
      issueType: String(p.issueType ?? "unknown"),
      category: String(p.category ?? "general"),
      location: String(p.location ?? "Unspecified"),
      severity: (["low", "medium", "high", "critical"].includes(p.severity) ? p.severity : "medium") as Severity,
      urgency: String(p.urgency ?? "this week"),
      recurring: Boolean(p.recurring),
      affectedUsers: String(p.affectedUsers ?? "Building occupants"),
      likelyAssetKeywords: Array.isArray(p.likelyAssetKeywords) ? p.likelyAssetKeywords.map(String) : [],
      summary: String(p.summary ?? signal.text),
    }),
    stub: () => {
      const recurring = RECUR_WORDS.some((w) => signal.text.toLowerCase().includes(w)) || signal.stillHappening === true;
      const category = detectCategory(signal.text);
      const severity = detectSeverity(signal.text, recurring);
      const location = detectLocation(signal);
      const keywords = (CATEGORY_KEYWORDS[category] ?? []).filter((w) => signal.text.toLowerCase().includes(w));
      return {
        issueType: category.replace(/_/g, " "),
        category,
        location,
        severity,
        urgency: severity === "critical" ? "same day" : severity === "high" ? "24-48h" : "this week",
        recurring,
        affectedUsers: signal.whoAffected ?? "Building occupants in the affected area",
        likelyAssetKeywords: keywords.length ? keywords : [category],
        summary: `${cap(category.replace(/_/g, " "))} issue reported at ${location}${recurring ? " (recurring)" : ""}: ${signal.text}`,
      };
    },
  });
}

// ============================================================
// 2. Enrichment agent  (≈ Tool use / grounding)
// ============================================================

export async function enrichmentAgent(
  issue: StructuredIssue,
  matches: AssetMatch[],
  publicRefs: PublicDataRef[]
): Promise<CompleteResult<Enrichment>> {
  const system =
    "You are the Enrichment agent. Translate real public data and asset records into OPERATIONAL MEANING for a facilities operator. Never dump links or counts without explaining what they imply for this issue.";
  const prompt =
    `Issue: ${issue.summary}\nCategory: ${issue.category}\n` +
    `Matched assets: ${matches.map((m) => `${m.name} (${m.product ?? "?"})`).join("; ") || "none"}\n` +
    `Public data found:\n${publicRefs.map((r) => `- ${r.source}: ${r.finding}`).join("\n") || "- none available"}\n` +
    `\nReturn JSON: { operationalMeaning: string, notes: string }. operationalMeaning = what all this means for fixing the issue.`;

  return complete<Enrichment>({
    system,
    prompt,
    validate: (p) => ({
      operationalMeaning: String(p.operationalMeaning ?? ""),
      publicData: publicRefs,
      notes: String(p.notes ?? ""),
    }),
    stub: () => {
      const asset = matches[0];
      const meaning =
        (asset
          ? `The report most likely involves "${asset.name}"${asset.product ? ` (${asset.product})` : ""}. `
          : "No specific asset matched yet — a field inspection is needed to attach one. ") +
        (asset?.troubleshooting
          ? `That asset has a documented troubleshooting path, so first response can follow its SOP rather than starting cold. `
          : "") +
        (publicRefs.length
          ? `Public records add context: ${publicRefs[0].finding}`
          : `No public records were retrievable, so this stands on the field report and asset history alone.`);
      return {
        operationalMeaning: meaning,
        publicData: publicRefs,
        notes: asset?.troubleshooting ? `Asset SOP/troubleshooting available for first response.` : `Attach an asset on inspection to unlock SOP context.`,
      };
    },
  });
}

// ============================================================
// 3. Review agent  (≈ Reflection / deep verification)
// ============================================================

export async function reviewAgent(
  signal: Signal,
  issue: StructuredIssue,
  matches: AssetMatch[]
): Promise<CompleteResult<Review>> {
  const system =
    "You are the Review agent — a skeptical facilities supervisor. Break the record into atomic factual claims and label each by how well it is grounded: Verified (directly observed by the student), Likely (strong inference), Inferred (AI guess), Missing (not captured), Needs inspection (only a site visit can confirm). Flag gaps. Decide if the root cause is uncertain.";
  const prompt =
    `Student said: "${signal.text}"\nStructured issue: ${JSON.stringify(issue)}\nMatched assets: ${matches.map((m) => m.name).join(", ") || "none"}\n` +
    `\nReturn JSON: { claims: [{statement, label, basis}], missingEvidence: [string], rootCauseUncertain: boolean, overallConfidence: label }.`;

  return complete<Review>({
    system,
    prompt,
    validate: (p) => ({
      claims: Array.isArray(p.claims) ? p.claims.map((c: any) => ({ statement: String(c.statement), label: c.label, basis: String(c.basis ?? "") })) : [],
      missingEvidence: Array.isArray(p.missingEvidence) ? p.missingEvidence.map(String) : [],
      rootCauseUncertain: Boolean(p.rootCauseUncertain),
      overallConfidence: p.overallConfidence ?? "Likely",
    }),
    stub: () => {
      const claims: Claim[] = [
        { statement: `The condition described ("${signal.text.slice(0, 60)}${signal.text.length > 60 ? "…" : ""}") is occurring.`, label: "Verified", basis: "Directly observed and reported by the student (source of truth)." },
        { statement: `Location is ${issue.location}.`, label: signal.locationHint || /room|floor|bathroom|gym/i.test(signal.text) ? "Verified" : "Inferred", basis: signal.locationHint ? "Provided by reporter." : "Parsed from free text." },
        { statement: `This is a ${issue.category} issue.`, label: "Likely", basis: "Classified from issue keywords." },
        { statement: `Severity is ${issue.severity}.`, label: "Inferred", basis: "Heuristic from language; not field-confirmed." },
        matches[0]
          ? { statement: `Affected asset is likely "${matches[0].name}".`, label: "Likely", basis: `Matched on keywords/trade (score ${matches[0].score}).` }
          : { statement: `No asset attached yet.`, label: "Missing", basis: "No confident match; needs inspection." },
      ];
      const missing: string[] = [];
      if (!signal.photoName) missing.push("Photo of the condition");
      if (signal.stillHappening == null) missing.push("Whether it is still happening right now");
      if (!matches.length) missing.push("Confirmed asset / equipment ID");
      missing.push("Duration / when it started", "Whether multiple fixtures or areas are affected");
      const rootCauseUncertain = issue.category === "plumbing" || issue.category === "hvac" || !matches.length;
      return { claims, missingEvidence: missing, rootCauseUncertain, overallConfidence: matches.length ? "Likely" : "Inferred" };
    },
  });
}

// ============================================================
// 3b. Debate agent  (only when root cause is uncertain)
// ============================================================

export async function debateAgent(issue: StructuredIssue, matches: AssetMatch[]): Promise<CompleteResult<Debate>> {
  const system =
    "You are moderating a short debate between two facilities experts about the most likely ROOT CAUSE. Expose the reasoning so a human can audit it. Two opposing hypotheses, one short argument each, then a resolution stating which to check first and why.";
  const prompt = `Issue: ${issue.summary}\nCategory: ${issue.category}\nCandidate assets: ${matches.map((m) => m.name).join(", ") || "unknown"}\nReturn JSON: { question, positions: [{hypothesis, argument}], resolution }.`;

  const ROOT_CAUSES: Record<string, [string, string]> = {
    plumbing: ["Failed trap seal / dry floor drain letting sewer gas in", "Partial blockage in the sanitary line backing up"],
    hvac: ["Airflow imbalance or failed damper actuator in the AHU zone", "Sensor drift / schedule mismatch reporting wrong setpoint"],
    electrical: ["Loose/overloaded connection generating heat", "Tripped or failing breaker on the affected circuit"],
    fire_and_life_safety: ["Battery/unit failure in the emergency device", "Wiring or sensor fault in the life-safety circuit"],
  };

  return complete<Debate>({
    system,
    prompt,
    validate: (p) => ({
      question: String(p.question ?? ""),
      positions: Array.isArray(p.positions) ? p.positions.map((x: any) => ({ hypothesis: String(x.hypothesis), argument: String(x.argument) })) : [],
      resolution: String(p.resolution ?? ""),
    }),
    stub: () => {
      const [a, b] = ROOT_CAUSES[issue.category] ?? ["Equipment fault", "Operational/usage factor"];
      return {
        question: `What is the most likely root cause of this ${issue.category} issue?`,
        positions: [
          { hypothesis: a, argument: `Consistent with the symptom and the matched equipment; cheapest to verify on site first.` },
          { hypothesis: b, argument: `Would explain recurrence even after a prior "fix"; check if the first hypothesis is ruled out.` },
        ],
        resolution: `Inspect for "${a}" first (fast, low-cost); if clear, escalate to test "${b}". Do not close until the recurrence path is ruled out.`,
      };
    },
  });
}

// ============================================================
// 4. Compliance agent
// ============================================================

export async function complianceAgent(issue: StructuredIssue, matches: AssetMatch[]): Promise<CompleteResult<Compliance>> {
  const system =
    "You are the Compliance agent. Identify which obligations the issue TOUCHES (regulatory, code, inspection, manufacturer, district SOP). Do NOT give legal advice — surface what an operator must consider before closing. Decide if escalation is warranted.";
  const allObs = matches.flatMap((m) => m.obligations);
  const prompt =
    `Issue: ${issue.summary} (category ${issue.category}, severity ${issue.severity}, recurring ${issue.recurring})\n` +
    `Obligations on matched assets: ${JSON.stringify(allObs)}\n` +
    `Return JSON: { obligations: [{title, basis, cadence}], escalate: boolean, escalationReason: string }.`;

  return complete<Compliance>({
    system,
    prompt,
    validate: (p) => ({
      obligations: Array.isArray(p.obligations) ? p.obligations.map((o: any) => ({ title: String(o.title), basis: String(o.basis ?? ""), cadence: o.cadence ?? null })) : [],
      escalate: Boolean(p.escalate),
      escalationReason: String(p.escalationReason ?? ""),
    }),
    stub: () => {
      const obligations = allObs.slice(0, 4).map((o) => ({
        title: `${o.category.replace(/_/g, " ")}${o.trade ? ` · ${o.trade}` : ""}`,
        basis: `Tags: ${o.tags.join(", ") || "—"}. Roles: ${o.roles.join(", ") || "—"}. Tools: ${o.tools.join(", ") || "—"}.`,
        cadence: o.cadence,
      }));
      // Category-level obligation hints even when no asset matched.
      const CATEGORY_OBLIGATIONS: Record<string, { title: string; basis: string }> = {
        fire_and_life_safety: { title: "Egress / life-safety inspection", basis: "Issue touches exit/egress or emergency equipment — inspection + record before closure." },
        plumbing: { title: "Sanitation / plumbing code", basis: "Sewage/drainage issues carry sanitation and student-health considerations." },
        hvac: { title: "Ventilation / occupant comfort", basis: "Comfort + IAQ obligations; recurring complaints should be trended." },
        electrical: { title: "Electrical safety", basis: "Water-near-electrical or panel issues require a qualified-person check." },
      };
      if (!obligations.length && CATEGORY_OBLIGATIONS[issue.category]) {
        const c = CATEGORY_OBLIGATIONS[issue.category];
        obligations.push({ title: c.title, basis: c.basis, cadence: null });
      }
      const escalate =
        issue.severity === "critical" ||
        issue.category === "fire_and_life_safety" ||
        (issue.recurring && issue.severity !== "low");
      const escalationReason = escalate
        ? issue.category === "fire_and_life_safety"
          ? "Life-safety/egress equipment is implicated — escalate and link to compliance history before any closure."
          : issue.severity === "critical"
            ? "Severity is critical — escalate for same-day response."
            : "Recurring condition suggests a prior closure did not resolve root cause — escalate to prevent another false closure."
        : "Standard work-order handling is sufficient; no escalation trigger met.";
      return { obligations, escalate, escalationReason };
    },
  });
}

// ============================================================
// 5. Recommendation agent  (next best action)
// ============================================================

export async function recommendationAgent(
  signal: Signal,
  issue: StructuredIssue,
  matches: AssetMatch[],
  review: Review,
  compliance: Compliance
): Promise<CompleteResult<Recommendation>> {
  const system =
    "You are the Recommendation agent. Produce a clean, actionable work order an operator could act on Monday morning. Concrete next steps, a missing-evidence checklist, the right assignment group, a student-facing status message, and a closure-verification question.";
  const prompt =
    `Issue: ${JSON.stringify(issue)}\nTop asset: ${matches[0]?.name ?? "none"}\nAsset troubleshooting: ${matches[0]?.troubleshooting?.slice(0, 400) ?? "none"}\n` +
    `Missing evidence: ${review.missingEvidence.join(", ")}\nEscalate: ${compliance.escalate} (${compliance.escalationReason})\n` +
    `Return JSON: { cleanedWorkOrderTitle, cleanedDescription, severity, assignmentGroup, missingEvidenceChecklist: [string], nextActions: [string], studentStatusMessage, closureQuestion }.`;

  const GROUPS: Record<string, string> = {
    hvac: "HVAC / Mechanical",
    plumbing: "Plumbing",
    electrical: "Electrical",
    fire_and_life_safety: "Life Safety / EHS",
    structural: "Facilities / Structural",
    security: "Security / Access",
    general: "Facilities",
  };

  return complete<Recommendation>({
    system,
    prompt,
    validate: (p) => ({
      cleanedWorkOrderTitle: String(p.cleanedWorkOrderTitle ?? issue.summary),
      cleanedDescription: String(p.cleanedDescription ?? issue.summary),
      severity: (["low", "medium", "high", "critical"].includes(p.severity) ? p.severity : issue.severity) as Severity,
      assignmentGroup: String(p.assignmentGroup ?? GROUPS[issue.category] ?? "Facilities"),
      missingEvidenceChecklist: Array.isArray(p.missingEvidenceChecklist) ? p.missingEvidenceChecklist.map(String) : review.missingEvidence,
      nextActions: Array.isArray(p.nextActions) ? p.nextActions.map(String) : [],
      studentStatusMessage: String(p.studentStatusMessage ?? ""),
      closureQuestion: String(p.closureQuestion ?? ""),
    }),
    stub: () => {
      const asset = matches[0];
      const next: string[] = [];
      if (asset) next.push(`Dispatch ${GROUPS[issue.category] ?? "Facilities"} to inspect "${asset.name}".`);
      if (asset?.troubleshooting) next.push(`Follow the documented troubleshooting path for ${asset.name} before replacing parts.`);
      next.push(`Capture the missing evidence (${review.missingEvidence.slice(0, 2).join(", ") || "photo + duration"}).`);
      if (issue.recurring) next.push(`Pull prior work orders for this location/asset and verify the previous closure actually resolved it.`);
      if (compliance.escalate) next.push(`Escalate: ${compliance.escalationReason}`);
      next.push(`Re-confirm with the reporting student after the work order is closed.`);
      return {
        cleanedWorkOrderTitle: `${cap(issue.issueType)} — ${issue.location}`,
        cleanedDescription: `${issue.summary} Affected: ${issue.affectedUsers}. Urgency: ${issue.urgency}.${issue.recurring ? " Reported as recurring." : ""}`,
        severity: issue.severity,
        assignmentGroup: GROUPS[issue.category] ?? "Facilities",
        missingEvidenceChecklist: review.missingEvidence,
        nextActions: next,
        studentStatusMessage: `Thanks — we logged your report about ${issue.location.toLowerCase()} and routed it to ${GROUPS[issue.category] ?? "Facilities"}. We'll check back with you to confirm it's actually fixed.`,
        closureQuestion: `Is the issue at ${issue.location} actually resolved now, still happening, or worse?`,
      };
    },
  });
}

// ============================================================
// 6. Verification agent  (closure loop)
// ============================================================

export function verificationDecision(report: "fixed" | "still_happening" | "worse"): { message: string; reopen: boolean; newSeverity?: Severity } {
  if (report === "fixed") {
    return { message: "Confirmed resolved by the original reporter. Closing the loop — the field signal validated the fix.", reopen: false };
  }
  if (report === "worse") {
    return { message: "Reporter says it got WORSE. Reopening and bumping severity — the previous handling did not hold. This is exactly the false-closure case the loop exists to catch.", reopen: true, newSeverity: "critical" };
  }
  return { message: "Reporter says it's still happening. Reopening — a 'closed' work order that didn't change reality is a false closure. Re-dispatch and re-verify.", reopen: true, newSeverity: "high" };
}

// ---- util ----
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
