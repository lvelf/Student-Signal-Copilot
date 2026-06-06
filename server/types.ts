/** Shared types for the Challenge 02 multi-agent pipeline. */

export type ConfidenceLabel = "Verified" | "Likely" | "Inferred" | "Missing" | "Needs inspection";
export type Severity = "low" | "medium" | "high" | "critical";

/** Raw input from the student / field user. */
export interface Signal {
  id: string;
  text: string; // one-line plain-English observation
  locationHint?: string; // "Room 304", "2nd floor bathroom by gym"
  stillHappening?: boolean;
  whoAffected?: string;
  photoName?: string; // we only store the filename, not the bytes
  submittedAt: string; // ISO
}

/** Output of the Extraction agent. */
export interface StructuredIssue {
  issueType: string; // plumbing / hvac / electrical / fire_and_life_safety ...
  category: string; // CriticalAsset workOrderServiceCategory
  location: string;
  severity: Severity;
  urgency: string; // "same day" | "this week" | "routine"
  recurring: boolean;
  affectedUsers: string;
  likelyAssetKeywords: string[]; // words we use to match real assets
  summary: string; // one clean sentence
}

/** A real CriticalAsset asset matched to the signal (grounding). */
export interface AssetMatch {
  id: string;
  name: string;
  product: string | null;
  locationAddress: string | null;
  score: number; // match strength 0..1
  sop?: string | null;
  troubleshooting?: string | null;
  obligations: Obligation[];
}

export interface Obligation {
  category: string; // e.g. OSHA_WorkplaceSafety
  trade: string | null;
  cadence: string | null; // "annual"
  tags: string[];
  roles: string[];
  tools: string[];
}

/** Output of the Enrichment agent. */
export interface Enrichment {
  operationalMeaning: string;
  publicData: PublicDataRef[];
  notes: string;
}
export interface PublicDataRef {
  source: string; // "NYC DOB Violations", "NYC 311"
  finding: string; // operational meaning, not a raw dump
  count?: number;
  url?: string;
}

/** One factual claim with a confidence label (Review agent). */
export interface Claim {
  statement: string;
  label: ConfidenceLabel;
  basis: string; // why this label
}
export interface Review {
  claims: Claim[];
  missingEvidence: string[];
  rootCauseUncertain: boolean;
  overallConfidence: ConfidenceLabel;
}

/** Optional debate when root cause is unclear. */
export interface Debate {
  question: string;
  positions: { hypothesis: string; argument: string }[];
  resolution: string;
}

/** Output of the Compliance agent. */
export interface Compliance {
  obligations: { title: string; basis: string; cadence: string | null }[];
  escalate: boolean;
  escalationReason: string;
}

/** Output of the Recommendation agent. */
export interface Recommendation {
  cleanedWorkOrderTitle: string;
  cleanedDescription: string;
  severity: Severity;
  assignmentGroup: string;
  missingEvidenceChecklist: string[];
  nextActions: string[];
  studentStatusMessage: string;
  closureQuestion: string;
}

/** One step in the supervisor's auditable trace. */
export interface TraceStep {
  agent: string;
  ran: boolean;
  reason: string; // why the supervisor ran (or skipped) it
  source: "claude" | "stub";
  model: string; // which model did the work (e.g. haiku / sonnet / rule)
  tier?: "light" | "heavy";
  ms: number;
}

export type VerificationStatus = "pending" | "fixed" | "still_happening" | "worse";

/** The full processed record — simulates the CriticalAsset write-back. */
export interface ProcessedRecord {
  id: string;
  signal: Signal;
  issue: StructuredIssue;
  assetMatches: AssetMatch[];
  enrichment: Enrichment;
  review: Review;
  debate: Debate | null;
  compliance: Compliance;
  recommendation: Recommendation;
  trace: TraceStep[];
  llmSource: "claude" | "stub";
  urgent: boolean; // guaranteed URGENT tag (deterministic): high/critical + recurring + still happening
  urgentReason: string;
  verification: { status: VerificationStatus; history: { status: VerificationStatus; at: string }[] };
  createdAt: string;
}

/** Output of the meta-overview agent — watches across ALL signals (cross-signal). */
export interface Overview {
  portfolioSummary: string;
  urgentIds: string[]; // records the overview confirms must surface to the top
  patterns: { title: string; recordIds: string[]; insight: string; recommendation: string }[];
  model: string;
  source: "claude" | "stub";
}
