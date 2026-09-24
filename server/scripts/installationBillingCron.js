// Installation bills now require an explicit Checked / OK action in Sales Billing.
// Keep these exports for existing server startup and operational callers; a timer
// must never approve DPRs or create client bills on a user's behalf.
function runOnce() {
  return { created: 0, bills: [], requires_check: true };
}
function scheduleInstallationBillingCron() {
  console.log('[install-billing] waiting for Checked / OK in Sales Billing');
}
module.exports = { scheduleInstallationBillingCron, runOnce };
