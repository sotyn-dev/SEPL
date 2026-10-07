// Keep weekly and applied-range responses tied to the user's current selection.
export function createLatestScorecardRequest(fetchCard, onCard, onError = () => {}) {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    async load(url) {
      const request = ++generation;
      try {
        const card = await fetchCard(url);
        if (request === generation) onCard(card);
        return card;
      } catch (error) {
        if (request === generation) onError(error);
        return null;
      }
    },
  };
}

export function createScorecardSelection(initial) {
  let selection = initial;
  return {
    get() { return selection; },
    set(value) { selection = value; },
  };
}

export function selectScorecardWeek(date, controls) {
  const week = normalizeScorecardRange({ from: date, to: date })?.from;
  if (!week) return null;
  controls.weekly.invalidate();
  controls.period.invalidate();
  controls.setScorecard(null);
  controls.setPeriodCard(null);
  controls.setRangeApplied(null);
  controls.setRangeStat(null);
  controls.setWeekStart(week);
  return week;
}

export function normalizeScorecardRange(range) {
  const monday = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    const weekday = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
    return date.toISOString().slice(0, 10);
  };
  let from = monday(range?.from), to = monday(range?.to);
  if (!from || !to) return null;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

// Finish saving the requested week, but do not reload it over a newer selection.
export async function saveSelectedScorecard(selection, save, getSelection, reload) {
  const result = await save();
  const current = getSelection();
  if (Number(current.userId) === Number(selection.userId) && current.weekStart === selection.weekStart) await reload(current);
  return result;
}

export function selectedScorecard({ scorecard, periodCard, rangeApplied, viewUserId, weekStart }) {
  if (rangeApplied) {
    const bounds = normalizeScorecardRange(rangeApplied);
    return bounds && periodCard && Number(periodCard.user_id) === Number(viewUserId)
      && periodCard.from === bounds.from && periodCard.to === bounds.to ? periodCard : null;
  }
  return scorecard && Number(scorecard.user_id) === Number(viewUserId)
    && scorecard.week_start === weekStart ? scorecard : null;
}
