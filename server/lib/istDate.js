// IST business-date helper. new Date().toISOString() is ALWAYS UTC, so
// between 00:00 and 05:30 IST it returns YESTERDAY's date — night entries
// (bills, collections, follow-ups, cron stamps) landed on the wrong day.
// Same fix as the SPOS cutoff audit 2026-07-31, now shared codebase-wide.
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

module.exports = { istToday };
