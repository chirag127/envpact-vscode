/**
 * envpact-vscode timestamps — dual-render UTC + IST per SHARED_SPEC §1.5.
 *
 * Mirrors envpact-cli/lib/timestamps.js byte-for-byte semantics so all
 * envpact components show identical timestamps.
 *
 * The vault stores `_modified_at` as canonical ISO-8601 UTC strings
 * (Z-suffix). Every prompt that surfaces a timestamp to a user MUST
 * display BOTH:
 *
 *   1. The verbatim ISO UTC string (exactly as stored on disk)
 *   2. The IST equivalent (`UTC+05:30`, fixed) as
 *      `YYYY-MM-DD HH:MM:SS IST`
 *
 * IST is computed via `Intl.DateTimeFormat` with
 * `timeZone: 'Asia/Kolkata'` so the rendering is independent of the
 * host's local timezone. Zero runtime dependencies — Node stdlib only.
 */

const IST_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export interface FormattedTimestamp {
  /** Verbatim ISO UTC string (the input). */
  utc: string;
  /** "YYYY-MM-DD HH:MM:SS IST" in Asia/Kolkata. */
  ist: string;
}

/**
 * Reformat a canonical ISO UTC string into both UTC and IST renderings.
 * Throws on invalid input rather than rendering bogus timestamps.
 */
export function formatTimestamp(iso: string): FormattedTimestamp {
  if (typeof iso !== 'string' || iso.length === 0) {
    throw new TypeError('formatTimestamp: iso must be a non-empty string');
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`formatTimestamp: invalid ISO timestamp: ${iso}`);
  }
  const date = new Date(ms);
  const parts = IST_FORMATTER.formatToParts(date);
  const get = (type: string): string => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : '';
  };
  // `hour: '2-digit', hour12: false` returns "24" at midnight on
  // some Node builds — normalise to "00" so the spec-mandated
  // YYYY-MM-DD HH:MM:SS shape is stable.
  let hour = get('hour');
  if (hour === '24') hour = '00';
  const ist =
    `${get('year')}-${get('month')}-${get('day')} ` +
    `${hour}:${get('minute')}:${get('second')} IST`;
  return { utc: iso, ist };
}

/**
 * Compare two ISO UTC strings. Returns 'a' / 'b' / 'tie' indicating
 * which side is newer. NaN inputs lose to the valid side; both NaN ties.
 */
export function newerSide(a: string, b: string): 'a' | 'b' | 'tie' {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 'tie';
  if (Number.isNaN(ta)) return 'b';
  if (Number.isNaN(tb)) return 'a';
  if (ta > tb) return 'a';
  if (tb > ta) return 'b';
  return 'tie';
}
