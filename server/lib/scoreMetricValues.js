const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function metricSettings(input, current = {}) {
  const settings = {
    planned_mode: input.planned_mode ?? current.planned_mode ?? 'source',
    actual_mode: input.actual_mode ?? current.actual_mode ?? 'source',
    metric_type: input.metric_type ?? current.metric_type ?? 'number',
    time_basis: input.time_basis ?? current.time_basis ?? 'elapsed',
  };
  if (!['source', 'manual'].includes(settings.planned_mode)
      || !['source', 'manual', 'dates'].includes(settings.actual_mode)
      || !['number', 'amount', 'hours'].includes(settings.metric_type)
      || !['elapsed', 'delay'].includes(settings.time_basis)) {
    throw new Error('Choose valid Plan, Actual, measurement and timing options');
  }
  if (settings.actual_mode === 'dates' && (settings.metric_type !== 'hours' || settings.planned_mode !== 'manual')) {
    throw new Error('Date/time calculation needs Hours and a manually entered hours target');
  }
  return settings;
}

// Date/time pickers use IST wall time, independent of browser/server timezone.
function dateTime(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(value)) {
    throw new Error('Use a valid date or date/time');
  }
  const normalized = value.length === 10 ? `${value}T00:00` : value;
  const milliseconds = Date.parse(`${normalized}:00+05:30`);
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds + 330 * 60000).toISOString().slice(0, 16) !== normalized) {
    throw new Error('Use a valid calendar date and time');
  }
  return { value, milliseconds };
}

function hoursFromDates(plannedAt, actualAt, basis = 'elapsed') {
  const start = dateTime(plannedAt), end = dateTime(actualAt);
  if (!start || !end) return null;
  const hours = (end.milliseconds - start.milliseconds) / 3600000;
  if (basis === 'elapsed' && hours < 0) throw new Error('Actual response must be on or after the start time');
  return Math.round((basis === 'delay' ? Math.max(0, hours) : hours) * 100) / 100;
}

function entryDates(input, existing = {}, kpi) {
  const plannedAt = has(input, 'planned_at') ? dateTime(input.planned_at)?.value ?? null : existing.planned_at ?? null;
  const actualAt = has(input, 'actual_at') ? dateTime(input.actual_at)?.value ?? null : existing.actual_at ?? null;
  if (kpi.actual_mode === 'dates' && actualAt && !plannedAt) throw new Error('Enter the planned/start time before the actual response time');
  const hours = kpi.actual_mode === 'dates' ? hoursFromDates(plannedAt, actualAt, kpi.time_basis) : null;
  return { planned_at: plannedAt, actual_at: actualAt, hours };
}

function achievement(planned, actual, direction) {
  if (+planned === 0 && +actual === 0) return 100;
  // A zero-hour delay target earns full credit only for an on-time response.
  if (+planned <= 0) return 0;
  return Math.max(0, direction === 'lower_better'
    ? (actual <= planned ? 100 : Math.round(planned / actual * 100))
    : Math.round(actual / planned * 100));
}

module.exports = { metricSettings, dateTime, hoursFromDates, entryDates, achievement };
