// FR-EVT-05 causal ordering of one correlation's events. Pure.
// Each event comes after its cause (causationId) when the cause is in the set; roots are events without a known cause.
// Siblings and roots keep (occurredAt, eventId) order, so the result is deterministic.
export interface Causal {
  readonly eventId: string;
  readonly causationId: string | null;
  readonly occurredAt: Date;
}

export function causalOrder<T extends Causal>(events: readonly T[]): T[] {
  const byTime = [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.eventId.localeCompare(b.eventId),
  );
  const ids = new Set(byTime.map((e) => e.eventId));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const e of byTime) {
    if (e.causationId !== null && e.causationId !== e.eventId && ids.has(e.causationId)) {
      children.set(e.causationId, [...(children.get(e.causationId) ?? []), e]);
    } else {
      roots.push(e);
    }
  }
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (e: T): void => {
    if (seen.has(e.eventId)) return; // defensive: a cycle never loops
    seen.add(e.eventId);
    out.push(e);
    for (const c of children.get(e.eventId) ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  for (const e of byTime) visit(e); // anything only reachable through a cycle
  return out;
}
