// Anonymous usage events via Vercel Web Analytics (cookieless; the script is loaded in index.html).
// Only counts and flags are sent: never message text, handles, room keys or anything typed.
// Forking? Without Vercel Web Analytics these calls are simply no-ops.

export function track(event, props = {}) {
  try {
    // Vercel accepts flat string/number/boolean/null values; drop undefined ones.
    const data = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
    window.va?.('event', { name: event, data });
  } catch {}
}
