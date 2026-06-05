/**
 * Time helpers for the 591 crawler.
 *
 * 591 never exposes an absolute "update" timestamp — only relative Chinese
 * strings ("5分鐘內更新", "2天前更新"). The detail page does expose an absolute
 * publish timestamp (`favData.posttime`, unix seconds). These helpers normalise
 * both into a single sortable "YYYY-MM-DD HH:MM:SS" string in Asia/Taipei
 * (UTC+8, no DST), so the sheet shows stable, comparable times.
 */

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Format a UTC instant as "YYYY-MM-DD HH:MM:SS" in Asia/Taipei. */
function formatTaipei(instantMs: number): string {
  const d = new Date(instantMs + TAIPEI_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Convert 591 detail-page `favData.posttime` (unix seconds) to UTC+8 string. */
export function unixToTaipei(unixSeconds: number): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "";
  return formatTaipei(unixSeconds * 1000);
}

/** Parse a "YYYY-MM-DD HH:MM:SS" UTC+8 string back to epoch milliseconds. */
export function parseTaipei(s: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, se) - TAIPEI_OFFSET_MS;
}

const UNIT_MS: Record<string, number> = {
  分鐘: 60 * 1000,
  小時: 60 * 60 * 1000,
  天: 24 * 60 * 60 * 1000,
};

/**
 * Convert a relative refresh string ("3小時內更新", "2天前更新") into an absolute
 * UTC+8 datetime, anchored to the crawl time. Returns null when unparseable.
 */
export function refreshToAbsolute(refresh: string, crawlAt: Date): string | null {
  const m = refresh.match(/(\d+)\s*(分鐘|小時|天)/);
  if (!m) return null;
  const offsetMs = Number(m[1]) * UNIT_MS[m[2]];
  return formatTaipei(crawlAt.getTime() - offsetMs);
}

/**
 * Decide whether a freshly computed update time represents a real 591 refresh
 * (vs. mere bucket drift from recomputing a coarse relative string each run).
 * Only treat it as a refresh when the candidate is newer than the stored value
 * by at least `thresholdMs`.
 */
export function shouldUpdateRefresh(
  stored: string,
  candidate: string,
  thresholdMs: number
): boolean {
  const candMs = parseTaipei(candidate);
  if (Number.isNaN(candMs)) return false;
  const storedMs = parseTaipei(stored);
  if (Number.isNaN(storedMs)) return true; // nothing usable stored yet
  return candMs - storedMs >= thresholdMs;
}
