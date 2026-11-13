import {
  APP_LINKS,
  EMAIL_LOGO_URL,
  EmailBrand,
  VOICES_LOGO_URL,
} from './email-config';

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
  /** Overrides {{join_link}} (and {{app_link}} is not touched). Default: the brand's app link. */
  joinLink?: string;
  unsubscribeUrl: string;
  /** EMAIL-03. Missing means `wmt`. */
  brand?: EmailBrand;
  /** EMAIL-03: an optional button under the body. */
  button?: { text: string; url: string } | null;
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
  vars: { firstName: string; joinLink: string; appLink?: string },
): string {
  return s
    .replace(/\{\{\s*first_name\s*\}\}/gi, () => vars.firstName)
    .replace(/\{\{\s*join_link\s*\}\}/gi, () => vars.joinLink)
    .replace(/\{\{\s*app_link\s*\}\}/gi, () => vars.appLink ?? vars.joinLink);
}

function safeUrl(url: string): string | null {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

/** A private-use character that marks where a link was set aside. */
const MARK = String.fromCharCode(0xe000);
const MARKED = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** The colours and fonts one brand draws the body with. */
interface Theme {
  link: string;
  text: string;
  font: string;
  headFont: string;
  button(label: string, url: string): string;
}

function inline(text: string, t: Theme): string {
  // Links first, as placeholders, so their text and address are escaped once.
  const links: string[] = [];
  const withTokens = text.replace(LINK, (whole, label: string, url: string) => {
    const safe = safeUrl(url);
    if (!safe) return label;
    links.push(
      `<a href="${escapeHtml(safe)}" style="color:${t.link};text-decoration:underline;">${escapeHtml(label)}</a>`,
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

function wmtButton(label: string, url: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;"><tr>` +
    `<td style="background:${ACCENT};border-radius:12px;">` +
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

const FONT_HEAD_VOICES =
  "'Rowdies','Arial Black',Impact,Helvetica,Arial,sans-serif";
const FONT_BODY_VOICES = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const V_GREEN = '#0DA86A';
const V_DEEP = '#002B1A';
const V_INK = '#0E1A14';
const V_MUTED = '#51605A';
const V_LINK = '#087A4C';

function voicesButton(label: string, url: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px;"><tr>` +
    `<td align="center" bgcolor="${V_GREEN}" style="background:${V_GREEN};border-radius:999px;">` +
    `<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:17px 34px;font-family:${FONT_BODY_VOICES};font-size:17px;font-weight:700;color:${V_DEEP};text-decoration:none;border-radius:999px;line-height:1;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

const WMT_THEME: Theme = {
  link: ACCENT,
  text: TEXT,
  font: FONT,
  headFont: FONT,
  button: wmtButton,
};
const VOICES_THEME: Theme = {
  link: V_LINK,
  text: V_INK,
  font: FONT_BODY_VOICES,
  headFont: FONT_HEAD_VOICES,
  button: voicesButton,
};

function bodyToHtml(body: string, t: Theme): string {
  const blocks = body.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: string[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const only = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(block);
    if (only && safeUrl(only[2])) {
      out.push(t.button(only[1], safeUrl(only[2]) as string));
      continue;
    }
    const heading = /^(#{1,2})\s+(.+)$/.exec(block);
    if (heading && !block.includes('\n')) {
      const size = heading[1].length === 1 ? 24 : 19;
      out.push(
        `<h2 style="margin:0 0 14px;font-family:${t.headFont};font-size:${size}px;line-height:1.3;color:${t.text};">${inline(heading[2], t)}</h2>`,
      );
      continue;
    }
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines
        .map(
          (l) =>
            `<li style="margin:0 0 6px;">${inline(l.replace(/^\s*[-*]\s+/, ''), t)}</li>`,
        )
        .join('');
      out.push(
        `<ul style="margin:0 0 18px;padding-left:22px;font-family:${t.font};font-size:16px;line-height:1.6;color:${t.text};">${items}</ul>`,
      );
      continue;
    }
    out.push(
      `<p style="margin:0 0 18px;font-family:${t.font};font-size:16px;line-height:1.6;color:${t.text};">${lines.map((l) => inline(l, t)).join('<br>')}</p>`,
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

const WMT_FOOTER =
  'You are getting this because you signed up on a WAWU platform and agreed to hear from us.';
const VOICES_FOOTER =
  'You are getting this because you have a Voices account and we have news for you.';

function buttonText(
  button: { text: string; url: string } | null | undefined,
): string {
  return button ? `\n\n${button.text}: ${button.url}` : '';
}

export function renderEmail(input: EmailRenderInput): RenderedEmail {
  const brand: EmailBrand = input.brand === 'voices' ? 'voices' : 'wmt';
  const vars = {
    firstName: input.firstName?.trim() || FALLBACK_FIRST_NAME,
    joinLink: input.joinLink ?? APP_LINKS[brand],
    appLink: APP_LINKS[brand],
  };
  const subject = mergeFields(input.subject, vars).replace(/\s+/g, ' ').trim();
  const preview = mergeFields(input.previewText ?? '', vars).trim();
  const body = mergeFields(input.body, vars);
  const unsub = escapeHtml(input.unsubscribeUrl);
  const button = input.button
    ? {
        text: mergeFields(input.button.text, vars),
        url: mergeFields(input.button.url, vars),
      }
    : null;
  const safeButton =
    button && safeUrl(button.url)
      ? { text: button.text, url: safeUrl(button.url) as string }
      : null;
  const text = (footer: string) =>
    `${bodyToText(body)}${buttonText(safeButton)}\n\n--\n${footer}\nUnsubscribe: ${input.unsubscribeUrl}\n`;

  if (brand === 'voices') {
    return {
      subject,
      html: voicesHtml({
        subject,
        preview,
        bodyHtml:
          bodyToHtml(body, VOICES_THEME) +
          (safeButton ? voicesButton(safeButton.text, safeButton.url) : ''),
        unsub,
      }),
      text: text(
        `${VOICES_FOOTER}\nVoices by WAWU Technology Ltd, ${APP_LINKS.voices}`,
      ),
    };
  }

  const hidden = preview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BG};">${escapeHtml(preview)}${'&nbsp;&zwnj;'.repeat(20)}</div>`
    : '';
  const bodyHtml =
    bodyToHtml(body, WMT_THEME) +
    (safeButton ? `\n${wmtButton(safeButton.text, safeButton.url)}` : '');

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
<tr><td style="padding:4px 8px 20px;"><img src="${EMAIL_LOGO_URL}" alt="Who Made This?" width="150" style="display:block;border:0;height:auto;width:150px;"></td></tr>
<tr><td style="background:${CARD};border:1px solid #26262f;border-radius:16px;padding:28px 24px 12px;">
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 8px 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
${WMT_FOOTER}<br>
<a href="${unsub}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html, text: text(WMT_FOOTER) };
}

/** The Voices look: a deep green band with the white wordmark, a white card, a green pill button. */
function voicesHtml(a: {
  subject: string;
  preview: string;
  bodyHtml: string;
  unsub: string;
}): string {
  const hidden = a.preview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#F5F5F5;">${escapeHtml(a.preview)}${'&nbsp;&zwnj;'.repeat(20)}</div>`
    : '';
  const app = APP_LINKS.voices;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(a.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Rowdies:wght@700&amp;display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:${FONT_BODY_VOICES};">
${hidden}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F5F5F5" style="background:#F5F5F5;">
<tr><td align="center" style="padding:24px 12px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td bgcolor="${V_DEEP}" style="background:${V_DEEP};padding:22px 28px;border-radius:28px 28px 0 0;"><a href="${app}"><img src="${VOICES_LOGO_URL}" width="126" alt="Voices" style="display:block;border:0;width:126px;max-width:100%;height:auto;"></a></td></tr>
<tr><td bgcolor="#FFFFFF" style="background:#FFFFFF;padding:32px 28px 20px;border-radius:0 0 28px 28px;">
${a.bodyHtml}
</td></tr>
<tr><td style="padding:22px 28px 0;font-family:${FONT_BODY_VOICES};font-size:12px;line-height:19px;color:${V_MUTED};">
${VOICES_FOOTER}<br>
Voices by WAWU Technology Ltd. <a href="${app}" style="color:${V_LINK};">usevoices.com</a><br>
<a href="${a.unsub}" style="color:${V_MUTED};text-decoration:underline;">Unsubscribe from Voices emails</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
