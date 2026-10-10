// Date-only UTC arithmetic avoids locale/DST shifts; start is Day 1.
export function rentalEndDate(start, days) {
  const count = Number(days);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !Number.isSafeInteger(count) || count <= 0) return '';
  const date = new Date(`${start}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== start) return '';
  date.setUTCDate(date.getUTCDate() + count - 1);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : '';
}
