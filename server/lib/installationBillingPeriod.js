function billingPeriod(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw Error('Invalid billing date');
  const [year, month, day] = date.split('-').map(Number);
  const prefix = date.slice(0,7);
  const last = new Date(Date.UTC(year,month,0)).getUTCDate();
  return { start:`${prefix}-${day <= 15 ? '01' : '16'}`, end:`${prefix}-${day <= 15 ? '15' : last}` };
}
function completedThrough(today) {
  const period = billingPeriod(today);
  return new Date(Date.parse(`${period.start}T00:00:00Z`) - 86400000).toISOString().slice(0,10);
}
module.exports = { billingPeriod, completedThrough };
