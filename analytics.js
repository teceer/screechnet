// Anonymous usage analytics (PostHog, EU cloud), proxied through /ingest (see vercel.json).
//
// Only explicit events with counts and flags are sent: never message text, handles,
// room keys or anything typed. No autocapture (it would record clicked text),
// no session recording, no cookies (in-memory id per visit). Off on localhost
// and when the browser sends Do Not Track.
//
// Forking? Replace KEY with your own project key, or delete this file's import in app.js.

const KEY = 'phc_UEfDUBQX836U29AvuakOIFlLgLHGibFcQLeTCjW5HSq';
const off = ['localhost', '127.0.0.1', ''].includes(location.hostname) || navigator.doNotTrack === '1';

if (!off) {
  // Minimal stand-in for PostHog's loader snippet: queue calls until array.js arrives,
  // then array.js picks up window.posthog._i (init args) and the queued calls.
  const ph = (window.posthog = []);
  ph._i = [];
  ph.__SV = 1;
  for (const m of ['capture', 'register', 'opt_out_capturing']) ph[m] = (...args) => ph.push([m, ...args]);
  ph._i.push([
    KEY,
    {
      api_host: '/ingest',
      ui_host: 'https://eu.posthog.com',
      persistence: 'memory',
      person_profiles: 'identified_only',
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,
      // the shared project's remote config turns these on; this page doesn't want them
      // (dead clicks and heatmaps record what was clicked, which can be message text)
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      enable_recording_console_log: false,
      capture_exceptions: true, // stack traces only: useful for spotting browsers where audio breaks
      disable_session_recording: true,
      disable_surveys: true,
      respect_dnt: true,
    },
  ]);
  ph.register({ app: 'screechnet' });
  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = '/ingest/static/array.js';
  document.head.append(s);
}

export function track(event, props) {
  try {
    if (!off) window.posthog.capture(event, props);
  } catch {}
}
