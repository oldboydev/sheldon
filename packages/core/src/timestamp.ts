/**
 * Converts an ISO-8601 timestamp to its instant in milliseconds, or returns undefined when the
 * value is not a timestamp accepted by the vault schema.
 */
export function isoTimestampEpoch(value: string): number | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  if (!validOffset(offset) || !validCalendar(year, month, day, hour, minute, second)) {
    return undefined;
  }
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? undefined : epoch;
}

function validOffset(value: string): boolean {
  if (value === 'Z') return true;
  const hours = Number(value.slice(1, 3));
  const minutes = Number(value.slice(4, 6));
  return hours <= 23 && minutes <= 59;
}

function validCalendar(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second
  );
}
