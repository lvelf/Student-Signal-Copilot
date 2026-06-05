/**
 * Pluggable LLM layer.
 *
 *  - If ANTHROPIC_API_KEY is set, each agent's reasoning is done by Claude (real).
 *  - If not, we fall back to a deterministic, rules-based stub that the agent
 *    supplies. The stub is grounded in REAL CriticalAsset data, so the demo is
 *    useful out of the box — paste a key and the same pipeline becomes real AI.
 *
 * Either way, agents call `complete()` and get back a typed object plus the
 * source ("claude" | "stub") so the UI can show an honest provenance badge.
 */

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export function hasLLM(): boolean {
  return Boolean(API_KEY);
}

export interface CompleteOptions<T> {
  system: string;
  prompt: string;
  /** Deterministic fallback used when no key is set or the call fails. */
  stub: () => T;
  /** Light validation; if it throws we fall back to the stub. */
  validate?: (parsed: any) => T;
}

export interface CompleteResult<T> {
  result: T;
  source: "claude" | "stub";
}

export async function complete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
  if (!API_KEY) {
    return { result: opts.stub(), source: "stub" };
  }
  try {
    const text = await callClaude(opts.system, opts.prompt);
    const parsed = extractJson(text);
    const result = opts.validate ? opts.validate(parsed) : (parsed as T);
    return { result, source: "claude" };
  } catch (err) {
    console.error("[llm] Claude call failed, using stub:", (err as Error).message);
    return { result: opts.stub(), source: "stub" };
  }
}

async function callClaude(system: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: system + "\n\nRespond with ONLY a single valid JSON object. No prose, no markdown fences.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.content?.[0]?.text ?? "";
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text: string): any {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON in response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON in response");
}

export const llmInfo = { model: MODEL, enabled: hasLLM() };
