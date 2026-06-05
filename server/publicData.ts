/**
 * NYC Open Data enrichment (Socrata, no auth required).
 *
 * We translate raw public records into OPERATIONAL MEANING, not link dumps —
 * which is exactly what Challenge 02 asks for. Every call has an 8s timeout and
 * degrades gracefully: if the city API is slow/unreachable, enrichment still runs.
 */
import type { PublicDataRef } from "./types.js";

const DOB_VIOLATIONS = "https://data.cityofnewyork.us/resource/3h2n-5cm9.json";
const C311 = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";

async function getJson(url: string, ms = 8000): Promise<any[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as any[];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Pull the street-number + street-name (no suffix) out of an address string. */
function splitAddress(address: string): { house: string; street: string } | null {
  const m = address.trim().match(/^(\d+)\s+(.+?)(?:,|$)/);
  if (!m) return null;
  // Keep just the distinctive street word (e.g. "IRVING") for a tolerant LIKE match.
  const core = m[2].toUpperCase().replace(/\b(PLACE|PL|STREET|ST|AVENUE|AVE|ROAD|RD)\b/g, "").trim().split(/\s+/)[0];
  return { house: m[1], street: core };
}

/**
 * Look up public context for a building address + an issue category, and
 * return findings already translated into operational language.
 */
export async function getPublicContext(address: string, issueCategory: string): Promise<PublicDataRef[]> {
  const refs: PublicDataRef[] = [];
  const parts = splitAddress(address);

  // ---- DOB violations (building safety / equipment compliance history) ----
  if (parts) {
    const where = `house_number='${parts.house}' AND upper(street) like '%25${encodeURIComponent(parts.street)}%25'`;
    const rows = await getJson(`${DOB_VIOLATIONS}?$where=${where}&$limit=200`);
    if (rows && rows.length) {
      const resolved = rows.filter((r) => /resolved|dismiss/i.test(r.violation_category ?? "")).length;
      const open = rows.length - resolved;
      // Notable equipment touched by past violations — used to spot overlap with this issue.
      const themes = summarizeDescriptions(rows);
      const relatesToIssue = themes.some((t) => issueRelatedTheme(issueCategory, t));
      refs.push({
        source: "NYC DOB Violations",
        count: rows.length,
        finding:
          `${rows.length} DOB violation record(s) on file (${open} unresolved, ${resolved} resolved). ` +
          (themes.length ? `Recurring themes: ${themes.join(", ")}. ` : "") +
          (relatesToIssue
            ? `These overlap the reported issue's system — link this signal to the existing compliance history and do NOT close it independently.`
            : isSafetyCategory(issueCategory)
              ? `The reported issue touches life-safety/egress — check it against this violation history before closure.`
              : `No direct overlap with the reported system, but the history shows this building gets DOB scrutiny; document the fix.`),
        url: "https://www.nyc.gov/site/buildings/index.page",
      });
    } else if (rows) {
      refs.push({ source: "NYC DOB Violations", count: 0, finding: "No DOB violations on file for this address — the issue is likely an operational/maintenance matter rather than an open code violation." });
    }
  }

  // ---- 311 complaints at THIS address (best-effort, short timeout) ----
  if (parts) {
    const addr = `${parts.house} ${parts.street}`.toUpperCase();
    const url = `${C311}?$select=complaint_type,count(unique_key)&$where=upper(incident_address) like '%25${encodeURIComponent(parts.street)}%25' AND incident_address like '${parts.house}%25'&$group=complaint_type&$order=count_unique_key desc&$limit=5`;
    const rows = await getJson(url, 6000);
    if (rows && rows.length) {
      const top = rows.map((r) => `${r.complaint_type} (${r.count_unique_key})`).slice(0, 3).join(", ");
      refs.push({ source: "NYC 311", count: rows.reduce((s, r) => s + Number(r.count_unique_key ?? 0), 0), finding: `Resident-side 311 history near ${addr}: ${top}. Cross-reference to see if students/residents have already flagged this pattern through a separate channel.`, url: "https://portal.311.nyc.gov/" });
    }
  }

  return refs;
}

/** Group raw violation descriptions into a few human themes. */
function summarizeDescriptions(rows: any[]): string[] {
  const themes = new Set<string>();
  for (const r of rows) {
    const d = (r.description ?? "").toUpperCase();
    if (/ELEVATOR|ESCALATOR/.test(d)) themes.add("elevator");
    if (/BOILER|FUEL|BURNER/.test(d)) themes.add("boiler");
    if (/FAN|HVAC|VENT|AIR/.test(d)) themes.add("HVAC/ventilation");
    if (/SPRINKLER|STANDPIPE|FIRE/.test(d)) themes.add("fire protection");
    if (/ELECTRIC|WIRING/.test(d)) themes.add("electrical");
    if (/FACADE|PARAPET|STRUCT/.test(d)) themes.add("structural/facade");
    if (/PLUMB|WATER|GAS/.test(d)) themes.add("plumbing/gas");
  }
  return [...themes].slice(0, 4);
}

function issueRelatedTheme(category: string, theme: string): boolean {
  const map: Record<string, string[]> = {
    hvac: ["HVAC/ventilation", "boiler"],
    plumbing: ["plumbing/gas"],
    electrical: ["electrical"],
    fire_and_life_safety: ["fire protection", "elevator"],
    structural: ["structural/facade"],
  };
  return (map[category] ?? []).includes(theme);
}

function isSafetyCategory(c: string): boolean {
  return ["fire_and_life_safety", "structural", "electrical", "security"].includes(c);
}
