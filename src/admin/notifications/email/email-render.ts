import { EMAIL_LOGO_URL, JOIN_LINK } from './email-config';

/**
 * Turns a template (Markdown or simple text with {{first_name}} and
 * {{join_link}}) into the final email: one branded, dark, mobile friendly HTML
 * layout and a plain-text part. Pure: no I/O, so the dashboard preview and the
 * real send produce the same bytes.
 *
 * Supported text: paragraphs (blank line between), line breaks, # and ##
 * headings, "- " lists, **bold**, *italic* and [label](https://link). A
 * paragraph that is only a link is drawn as the purple button. Everything is
 * escaped; only http(s) and mailto links are kept.
 */

export interface EmailRenderInput {
  subject: string;
  previewText?: string;
  body: string;
  firstName?: string | null;
  joinLink?: string;
  unsubscribeUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** What {{first_name}} says when the list has no name for the person. */
export const FALLBACK_FIRST_NAME = 'there';

const BG = '#0b0b0f';
const CARD = '#15151b';
const TEXT = '#f4f4f6';
const MUTED = '#9a9aa6';
const ACCENT = '#9411C9';
const FONT = "'Alan Sans','Helvetica Neue',Helvetica,Arial,sans-serif";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fills the two merge fields. Anything else in braces is left as typed. */
export function mergeFields(
  s: string,
  vars: { firstName: string; joinLink: string },
): string {
  return s
    .replace(/\{\{\s*first_name\s*\}\}/gi, () => vars.firstName)
    .replace(/\{\{\s*join_link\s*\}\}/gi, () => vars.joinLink);
}

function safeUrl(url: string): string | null {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

/** A private-use character that marks where a link was set aside. */
const MARK = String.fromCharCode(0xe000);
const MARKED = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string): string {
  // Links first, as placeholders, so their text and address are escaped once.
  const links: string[] = [];
  const withTokens = text.replace(LINK, (whole, label: string, url: string) => {
    const safe = safeUrl(url);
    if (!safe) return label;
    links.push(
      `<a href="${escapeHtml(safe)}" style="color:${ACCENT};text-decoration:underline;">${escapeHtml(label)}</a>`,
    );
    return `${MARK}${links.length - 1}${MARK}`;
  });
  let out = escapeHtml(withTokens);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out.replace(MARKED, (_m, i: string) => links[Number(i)]);
}

function plainInline(text: string): string {
  return text
    .replace(LINK, (_w, label: string, url: string) => {
      const safe = safeUrl(url);
      return safe ? `${label} (${safe})` : label;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
}

function button(label: string, url: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;"><tr>` +
    `<td style="background:${ACCENT};border-radius:12px;">` +
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

function bodyToHtml(body: string): string {
  const blocks = body.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: string[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const only = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(block);
    if (only && safeUrl(only[2])) {
      out.push(button(only[1], safeUrl(only[2]) as string));
      continue;
    }
    const heading = /^(#{1,2})\s+(.+)$/.exec(block);
    if (heading && !block.includes('\n')) {
      const size = heading[1].length === 1 ? 24 : 19;
      out.push(
        `<h2 style="margin:0 0 14px;font-family:${FONT};font-size:${size}px;line-height:1.3;color:${TEXT};">${inline(heading[2])}</h2>`,
      );
      continue;
    }
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines
        .map(
          (l) =>
            `<li style="margin:0 0 6px;">${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`,
        )
        .join('');
      out.push(
        `<ul style="margin:0 0 18px;padding-left:22px;font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT};">${items}</ul>`,
      );
      continue;
    }
    out.push(
      `<p style="margin:0 0 18px;font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT};">${lines.map(inline).join('<br>')}</p>`,
    );
  }
  return out.join('\n');
}

function bodyToText(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) =>
      b
        .split('\n')
        .map((l) => plainInline(l.replace(/^#{1,2}\s+/, '')))
        .join('\n'),
    )
    .join('\n\n');
}

export function renderEmail(input: EmailRenderInput): RenderedEmail {
  const vars = {
    firstName: input.firstName?.trim() || FALLBACK_FIRST_NAME,
    joinLink: input.joinLink ?? JOIN_LINK,
  };
  const subject = mergeFields(input.subject, vars).replace(/\s+/g, ' ').trim();
  const preview = mergeFields(input.previewText ?? '', vars).trim();
  const body = mergeFields(input.body, vars);
  const unsub = escapeHtml(input.unsubscribeUrl);

  const hidden = preview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BG};">${escapeHtml(preview)}${'&nbsp;&zwnj;'.repeat(20)}</div>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};">
${hidden}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:4px 8px 20px;"><img src="${EMAIL_LOGO_URL}" alt="Who Made This" width="150" style="display:block;border:0;height:auto;width:150px;"></td></tr>
<tr><td style="background:${CARD};border:1px solid #26262f;border-radius:16px;padding:28px 24px 12px;">
${bodyToHtml(body)}
</td></tr>
<tr><td style="padding:20px 8px 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
You are getting this because you signed up on a WAWU platform and agreed to hear from us.<br>
<a href="${unsub}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = `${bodyToText(body)}\n\n--\nYou are getting this because you signed up on a WAWU platform and agreed to hear from us.\nUnsubscribe: ${input.unsubscribeUrl}\n`;
  return { subject, html, text };
}
