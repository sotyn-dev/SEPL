// Optional Sentry integration for the frontend.
//
// Activated only when VITE_SENTRY_DSN is set in client/.env (or the
// build environment). Without it, this module exports a passthrough
// ErrorBoundary so the rest of the app still mounts cleanly in dev.
//
// Env vars (set in client/.env or via the deploy environment):
//   VITE_SENTRY_DSN              The frontend DSN from Sentry
//   VITE_SENTRY_RELEASE          Optional release tag (e.g. git SHA)

import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    integrations: [
      Sentry.browserTracingIntegration(),
      // Session Replay only kicks in when there's an error — privacy-safe
      // (text masked, media blocked) and cheap on the Sentry quota.
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 1.0,
    // Don't ship Authorization headers / JWTs to Sentry.
    beforeSend(event) {
      try {
        if (event.request?.headers) {
          delete event.request.headers.Authorization;
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        if (event.breadcrumbs) {
          for (const b of event.breadcrumbs) {
            if (b?.data?.request_headers) delete b.data.request_headers;
          }
        }
      } catch {}
      return event;
    },
  });
  // eslint-disable-next-line no-console
  console.log('[sentry] initialized for', dsn.replace(/\/\/.*@/, '//***@'));

  // Expose Sentry on window so admins can fire test events from the
  // DevTools console without needing access to the bundled module.
  // Useful for verifying the pipeline end-to-end:
  //   window.Sentry.captureMessage('hello')
  //   window.Sentry.captureException(new Error('boom'))
  if (typeof window !== 'undefined') {
    window.Sentry = Sentry;
  }
}

export { Sentry };
