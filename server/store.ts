/**
 * In-memory store for processed signals.
 *
 * This stands in for the "CriticalAsset update" step in the diagram: our app
 * token is read-only (no workorders.write scope), so instead of writing back to
 * CriticalAsset we persist the enriched record + verification state here. The
 * closure loop is fully functional against this store.
 */
import type { ProcessedRecord } from "./types.js";

const records = new Map<string, ProcessedRecord>();
let counter = 1000;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function save(rec: ProcessedRecord): void {
  records.set(rec.id, rec);
}

export function get(id: string): ProcessedRecord | undefined {
  return records.get(id);
}

export function list(): ProcessedRecord[] {
  return [...records.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
