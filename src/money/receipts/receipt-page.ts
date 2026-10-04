import { RECEIPT_TOKENS, type ReceiptTone } from '../../styles/tokens-receipt';
import type { PublicReceipt, PublicReceiptParty } from './receipt-document';
import { escapeXml } from './receipt-render';

/**
 * The public page at wawu/r/<code> (task WALLET-18): plain HTML, no script,
 * no outside request and no image. It shows only
 * what proves the movement: the amount, the date, the status, both sides
 * masked (a first name and initials, at most the last 4 digits of an
 * account) and the reference. Never a full account number, a phone, an
 * email, a handle, a note or what the money paid for.
 */

const TONES: ReceiptTone[] = ['positive', 'warning', 'danger', 'ink'];

const T = RECEIPT_TOKENS;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeXml(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:${T.page};color:${T.ink};font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:420px;background:${T.paper};border-radius:22px;padding:22px 20px;box-shadow:inset 0 0 0 1px ${T.hairline}}
.head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.title{font-size:13px;font-weight:700;letter-spacing:.06em;color:${T.accent}}
.date{font-size:12px;color:${T.muted}}
.mid{display:flex;flex-direction:column;align-items:center;gap:4px;padding:18px 0 8px;text-align:center}
.what{font-size:13px;color:${T.muted}}
.amount{font-size:34px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.status{font-size:12px;font-weight:700}
dl{margin:8px 0 0}
.row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid ${T.hairline};font-size:13px}
dt{color:${T.muted}}
dd{margin:0;font-weight:600;text-align:right;overflow-wrap:anywhere}
.sub{display:block;font-weight:400;color:${T.muted}}
.foot{margin-top:14px;font-size:11px;color:${T.faint};text-align:center}
h1{font-size:20px;margin:6px 0 8px}
p{font-size:14px;color:${T.muted};margin:0}
${TONES.map((t) => `.t-${t}{color:${T[t]}}`).join('\n')}
</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

function party(p: PublicReceiptParty): string {
  return `${escapeXml(p.name)}${p.account ? `<span class="sub">${escapeXml(p.account)}</span>` : ''}`;
}

/** The page for a code that matches a receipt. */
export function receiptPage(r: PublicReceipt): string {
  const rows: [string, string][] = [['Type', escapeXml(r.typeLabel)]];
  if (r.from) rows.push(['From', party(r.from)]);
  if (r.to) rows.push(['To', party(r.to)]);
  rows.push(['Date', escapeXml(r.dateText)]);
  rows.push(['Reference', escapeXml(r.reference)]);
  const foot = [`Receipt ${r.link} on Who Made This.`, r.licenceLine]
    .filter(Boolean)
    .map((l) => escapeXml(l as string))
    .join(' ');
  return shell(
    'Receipt check',
    `<div class="head"><span class="title">TRANSACTION RECEIPT</span><span class="date">${escapeXml(r.dateText)}</span></div>
<div class="mid"><span class="what">${escapeXml(r.typeLabel)}</span><span class="amount t-${r.amountTone}">${escapeXml(r.amountText)}</span><span class="status t-${r.statusTone}">${escapeXml(r.statusText)}</span></div>
<dl>${rows.map(([k, v]) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
<div class="foot">${foot}</div>`,
  );
}

/** Every miss: an unknown code, a mistyped one, a receipt whose movement is gone. One page, byte for byte. */
export const RECEIPT_NOT_FOUND_PAGE = shell(
  'Receipt not found',
  `<h1>Receipt not found</h1><p>No receipt has this code. Check the code on the receipt you were sent and try again.</p>`,
);
