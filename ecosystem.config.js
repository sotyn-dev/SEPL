// PM2 process config for the SEPL ERP (mam 2026-06-25: stop the recurring
// 502 Bad Gateway). The 502 happens when the Node process drops and nothing
// brings it back: on the memory-starved VPS the Linux OOM-killer kills Node,
// leaving nginx with nothing on :5000. This config makes the process
// self-heal so a memory spike or crash is a ~1s blip, not a stuck outage.
//
// ONE app: `erp` (the API). It also EMBEDS the BullMQ worker runtime in-process
// (Workstream 1) — the push fan-out runs in-process and the heavy Excel export
// runs in a short-lived BullMQ sandboxed child process (off the API heap/loop).
// So there is no separate `erp-worker` process to manage on this single-fork
// 2-core box (mam 2026-07-14: the second always-on app was overkill).
//
// Deploy is scripted — don't run the raw commands by hand:
//   Routine deploy (each time):  bash scripts/deploy.sh
//   First-time Redis (once):     sudo bash scripts/setup-redis.sh
// deploy.sh uses `pm2 startOrReload ecosystem.config.js` + `pm2 save`. Full
// runbook: docs/REDIS_DEPLOY.md.
//
// FUTURE — PM2 cluster mode / multitenant: when you run N `erp` instances, add a
// second app here for `server/worker.js` (the standalone worker) AND set
// `ERP_EMBED_WORKER: '0'` in the `erp` env below, so the N API instances share
// ONE queue drain instead of each embedding its own.
//
// The DURABLE root fix is still a one-time 2 GB swap file (so the OOM-killer
// never fires at all) — see project_deployment notes. This config is the
// belt-and-suspenders that makes recovery automatic.
module.exports = {
  apps: [{
    name: 'erp',
    script: 'server/index.js',
    cwd: '/root/erp',
    instances: 1,
    exec_mode: 'fork',

    // Always bring it back if it exits for any reason.
    autorestart: true,

    // If the process ever balloons (a leak / runaway request), let PM2
    // restart it GRACEFULLY before the OOM-killer does it violently. A PM2
    // restart is a clean ~1s reconnect; an OOM kill is the stuck 502. The
    // embedded worker doesn't raise this: the heavy Excel build runs in a
    // separate sandboxed child process with its OWN heap, not the API's.
    max_memory_restart: '600M',

    // Cap the V8 heap so a spike can't run away unbounded.
    node_args: '--max-old-space-size=512',

    // Crash-loop protection: back off instead of hammering restarts, and
    // require a real uptime before counting a start as "good".
    exp_backoff_restart_delay: 200,
    min_uptime: '15s',
    max_restarts: 50,

    // Give in-flight requests / SQLite writes time to finish on restart.
    kill_timeout: 8000,

    env: {
      NODE_ENV: 'production',
      PORT: 5000,
      // Embed the BullMQ worker in this process (default). Flip to '0' only for
      // the cluster-mode split described in the header, alongside a separate
      // erp-worker app.
      ERP_EMBED_WORKER: '1',
    },

    merge_logs: true,
    out_file: '/root/.pm2/logs/erp-out.log',
    error_file: '/root/.pm2/logs/erp-error.log',
    time: true,
  }],
};
