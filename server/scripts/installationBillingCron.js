const { istToday } = require('../lib/istDate');
// Daily catch-up for closed fortnights, including late DPR approvals.
// DPR links prevent duplicate billing. No client communication is sent.
function runOnce(today = istToday()) {
  const { getDb } = require('../db/schema');
  const { generateInstallationBills } = require('../routes/salesBilling');
  return generateInstallationBills(getDb(), null, { today });
}
function scheduleInstallationBillingCron() {
  if (process.env.ERP_DISABLE_INSTALL_BILLING === '1') return;
  const tick = () => {
    const today = istToday();
    try {
      const result = runOnce(today);
      require('../lib/raBillingWorkflow').followups(require('../db/schema').getDb(),today);
      if (result.skipped?.length) console.warn('[install-billing] periods needing rate/quantity correction:', result.skipped);
      if (result.created) console.log(`[install-billing] created ${result.created} bill(s)`);
    } catch (error) { console.error('[install-billing]', error.message); }
  };
  setTimeout(tick, 30000).unref();
  const timer = setInterval(tick, 60 * 1000);
  timer.unref();
  return timer;
}
module.exports = { scheduleInstallationBillingCron, runOnce };
