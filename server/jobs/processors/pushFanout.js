// Processor for the `push-fanout` job (Workstream 1). Runs in the worker
// process (server/worker.js). The heavy part — looping every active device and
// awaiting the push server per device — moves here off the API event loop, with
// BullMQ retries/backoff so a slow or briefly-failed push server no longer drops
// notifications. The send logic itself is unchanged: we call the SAME
// runPushFanout() the inline fallback uses, so both paths behave identically.
const { runPushFanout } = require('../../lib/push');

module.exports = async function pushFanout(job) {
  const res = await runPushFanout(job.data);   // { sent, total }
  return res;
};
