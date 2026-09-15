export function probationEndDate(joinDate, months) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joinDate || '') || ![3, 6].includes(months)) return '';
  const [year, month, day] = joinDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
