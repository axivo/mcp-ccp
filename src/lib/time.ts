/**
 * Time conversion helpers
 *
 * @module lib/time
 * @author AXIVO
 * @license BSD-3-Clause
 */

/**
 * Time conversion helpers
 *
 * Converts UTC timestamps stored in the database to local-with-offset
 * strings anchored to the active sibling's timezone. Renders human-readable
 * display prose for dashboard surfaces. Reports DST status for the active
 * timezone. Stateless static methods, no instance required.
 *
 * @class Time
 */
export class Time {
  /**
   * Returns whether the given timezone is currently in daylight saving time
   *
   * Compares the offset of January 1 against July 1 of the current year.
   * When they differ, the timezone observes DST and the current offset
   * matches one of those two extremes; the larger offset (closer to summer)
   * is DST.
   *
   * @static
   * @param {string} timezone - IANA timezone (e.g., 'America/Toronto')
   * @returns {boolean} True when the timezone currently observes DST
   */
  static isDst(timezone: string): boolean {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' });
    const parseOffset = (date: Date): number => {
      const tz = formatter.formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
      const match = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (!match) return 0;
      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const minutes = match[3] ? parseInt(match[3], 10) : 0;
      return sign * (hours * 60 + minutes);
    };
    const jan = parseOffset(new Date(now.getFullYear(), 0, 1));
    const jul = parseOffset(new Date(now.getFullYear(), 6, 1));
    if (jan === jul) return false;
    const current = parseOffset(now);
    return current === Math.max(jan, jul);
  }

  /**
   * Renders a UTC timestamp as human-readable prose in the active sibling's timezone
   *
   * Used for session metadata that appears in dashboard UIs and default
   * descriptions, e.g. "Saturday, May 9, 2026, 8:31 PM EDT".
   *
   * @static
   * @param {Date | string | null | undefined} utc - UTC timestamp
   * @param {string} timezone - IANA timezone (e.g., 'America/Toronto')
   * @returns {string | null} Human-readable display string, or null when input is null
   */
  static toDisplay(utc: Date | string | null | undefined, timezone: string): string | null {
    if (utc === null || utc === undefined) return null;
    const date = typeof utc === 'string' ? new Date(utc) : utc;
    if (Number.isNaN(date.getTime())) return null;
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
    return `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')}, ${get('hour')}:${get('minute')} ${get('dayPeriod')} ${get('timeZoneName')}`;
  }

  /**
   * Converts a UTC timestamp to ISO 8601 with the active sibling's timezone offset
   *
   * Database columns are stored as UTC (`timestamptz`). Wire format is always
   * local-with-offset for the active sibling's timezone, so consumers see
   * times anchored to where the active conversation happens. UTC remains
   * implicit through the offset suffix (`-04:00`, `+09:00`).
   *
   * @static
   * @param {Date | string | null | undefined} utc - UTC timestamp (Date object, ISO string, or null)
   * @param {string} timezone - IANA timezone (e.g., 'America/Toronto')
   * @returns {string | null} ISO 8601 string with timezone offset, or null when input is null
   */
  static toLocal(utc: Date | string | null | undefined, timezone: string): string | null {
    if (utc === null || utc === undefined) return null;
    const date = typeof utc === 'string' ? new Date(utc) : utc;
    if (Number.isNaN(date.getTime())) return null;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset'
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
    const tz = get('timeZoneName');
    const offset = tz.startsWith('GMT') ? tz.slice(3) || '+00:00' : '+00:00';
    const normalizedOffset = /^[+-]\d{2}:\d{2}$/.test(offset)
      ? offset
      : (offset.match(/^([+-])(\d{1,2})$/) ? `${RegExp.$1}${RegExp.$2.padStart(2, '0')}:00` : '+00:00');
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${normalizedOffset}`;
  }
}

export default Time;
