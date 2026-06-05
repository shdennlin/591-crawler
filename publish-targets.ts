/**
 * Decide which listing IDs to fetch absolute publish times for in a single run.
 *
 * Publish time lives only on the detail page, so each fetch costs a request.
 * New listings are always prioritised; remaining budget backfills existing rows
 * that are still ACTIVE and missing a publish time. Inactive (delisted) rows are
 * never backfilled — their detail pages 404, so retrying them every run would
 * waste budget and never succeed.
 */
export interface ExistingRowInfo {
  id: string;
  hasPublish: boolean;
  isActive: boolean;
}

export function selectPublishTargets(
  newIds: string[],
  existing: ExistingRowInfo[],
  budget: number
): string[] {
  const targets = newIds.slice(0, budget);
  for (const row of existing) {
    if (targets.length >= budget) break;
    if (!row.hasPublish && row.isActive) targets.push(row.id);
  }
  return targets;
}
