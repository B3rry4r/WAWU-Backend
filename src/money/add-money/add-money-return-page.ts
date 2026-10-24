/**
 * The page Nuvion's hosted pages send the person back to (WALLET-25,
 * WALLET-26). It holds no payment data and reads nothing: a heading, a line,
 * and a button that opens the app on the attempt's screen. The app asks the
 * Hub what happened. The scheme is the app's own (`wawu`, app.json).
 */
const APP_SCHEME = 'wawu';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function returnPage(id: string | undefined): string {
  const safe =
    typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  const link = `${APP_SCHEME}://add-money/status${safe ? `?id=${safe}` : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>Back to the app</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f6f5f8;color:#111018}
main{max-width:360px;padding:32px 24px;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 24px;color:#5a5766}
a{display:inline-block;padding:14px 28px;border-radius:999px;background:#9411c9;color:#fff;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#111018;color:#f6f5f8}p{color:#b9b6c4}}
</style></head>
<body><main><h1>Back to the app</h1>
<p>Open the app to see how your payment went.</p>
<a id="open" href="${link}">Open the app</a></main>
<script>setTimeout(function(){location.href=document.getElementById('open').href},400)</script>
</body></html>`;
}
