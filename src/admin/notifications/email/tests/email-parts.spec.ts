/* eslint-disable @typescript-eslint/require-await */
import { planAudience } from '../email-audience';
import { CsvFormatError, parseAudienceCsv } from '../email-csv';
import { RequestPacer } from '../email-pacer';
import { renderEmail } from '../email-render';
import {
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from '../email-unsubscribe';
import {
  DEFAULT_EMAIL_CAMPAIGN_FROM,
  emailFrom,
  resendBaseUrl,
} from '../email-config';

const SECRET = 'a-secret-that-is-at-least-thirty-two-chars';
const UNSUB = 'https://api.example.test/api/hub/email/unsubscribe?t=abc.def';

describe('EMAIL-01 rendering', () => {
  const base = {
    subject: 'Hi {{first_name}}, come and join',
    previewText: 'Your spot, {{first_name}}',
    body: 'Hello **{{first_name}}**,\n\nRegister here:\n\n[Join WAWU]({{join_link}})\n\n- one\n- two',
    unsubscribeUrl: UNSUB,
  };

  it('fills first_name and join_link in subject, preview and body', () => {
    const mail = renderEmail({ ...base, firstName: 'Ada' });
    expect(mail.subject).toBe('Hi Ada, come and join');
    expect(mail.html).toContain('<strong>Ada</strong>');
    expect(mail.html).toContain('href="https://wawuafrica.com/join"');
    expect(mail.html).toContain('Your spot, Ada');
    expect(mail.text).toContain('Hello Ada,');
    expect(mail.text).toContain('Join WAWU (https://wawuafrica.com/join)');
    expect(mail.html).not.toContain('{{');
  });

  it('says "there" when there is no first name', () => {
    expect(renderEmail({ ...base, firstName: null }).subject).toBe(
      'Hi there, come and join',
    );
  });

  it('draws a lone link as the purple button inside the dark layout', () => {
    const { html } = renderEmail({ ...base, firstName: 'Ada' });
    expect(html).toContain('background:#9411C9');
    expect(html).toContain('background:#0b0b0f');
    expect(html).toContain('who-made-this-white.png');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<li');
  });

  it('puts the unsubscribe link in the html and the text part', () => {
    const mail = renderEmail({ ...base, firstName: 'Ada' });
    expect(mail.html).toContain(`href="${UNSUB}"`);
    expect(mail.text).toContain(`Unsubscribe: ${UNSUB}`);
  });

  it('escapes markup and drops links that are not http, https or mailto', () => {
    const mail = renderEmail({
      subject: 's',
      body: '<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.test/p?x=1&y=2)',
      unsubscribeUrl: UNSUB,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('javascript:');
    expect(mail.html).toContain('href="https://a.test/p?x=1&amp;y=2"');
  });

  it('sends from the WAWUAfrica address unless EMAIL_CAMPAIGN_FROM is set', () => {
    expect(DEFAULT_EMAIL_CAMPAIGN_FROM).toBe(
      'WAWUAfrica <noreply@wawuafrica.com>',
    );
    expect(emailFrom({ get: () => undefined })).toBe(
      DEFAULT_EMAIL_CAMPAIGN_FROM,
    );
    expect(emailFrom({ get: () => 'Other <x@y.test>' })).toBe(
      'Other <x@y.test>',
    );
  });

  it('only talks to Resend or a local address', () => {
    expect(resendBaseUrl({ get: () => undefined })).toBe(
      'https://api.resend.com',
    );
    expect(resendBaseUrl({ get: () => 'http://127.0.0.1:6494/' })).toBe(
      'http://127.0.0.1:6494',
    );
    expect(() =>
      resendBaseUrl({ get: () => 'https://evil.example/' }),
    ).toThrow();
  });
});

describe('EMAIL-01 unsubscribe token', () => {
  it('round-trips the address, lower-cased', () => {
    const t = signUnsubscribeToken('Ada@Example.com', SECRET);
    expect(verifyUnsubscribeToken(t, SECRET)).toBe('ada@example.com');
  });
  it('refuses a changed address, a changed signature, another secret and junk', () => {
    const t = signUnsubscribeToken('ada@example.com', SECRET);
    const [, sig] = t.split('.');
    const other = Buffer.from('bob@example.com').toString('base64url');
    expect(verifyUnsubscribeToken(`${other}.${sig}`, SECRET)).toBeNull();
    expect(
      verifyUnsubscribeToken(`${t.split('.')[0]}.AAAA`, SECRET),
    ).toBeNull();
    expect(verifyUnsubscribeToken(t, `${SECRET}-different`)).toBeNull();
    expect(verifyUnsubscribeToken('nonsense', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(t, undefined)).toBeNull();
  });
  it('builds a link on the Hub address', () => {
    const url = unsubscribeUrl(
      'https://api.example.test/',
      'ada@example.com',
      SECRET,
    );
    expect(
      url.startsWith('https://api.example.test/api/hub/email/unsubscribe?t='),
    ).toBe(true);
  });
});

describe('EMAIL-01 CSV parsing and de-duplication', () => {
  it('reads email and first_name, lower-cases, and drops repeats (first row wins)', () => {
    const r = parseAudienceCsv(
      'Email,First Name,Phone\nAda@x.test,Ada,1\nbob@x.test,,2\nADA@x.test,Other,3\n',
    );
    expect(r.people).toEqual([
      { email: 'ada@x.test', firstName: 'Ada' },
      { email: 'bob@x.test', firstName: null },
    ]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toBe(0);
    expect(r.rows).toBe(3);
  });
  it('counts bad addresses and skips blank lines', () => {
    const r = parseAudienceCsv(
      'email\nnot-an-email\n\n a@b.co \nx@y\n@z.com\n',
    );
    expect(r.people.map((p) => p.email)).toEqual(['a@b.co']);
    expect(r.invalid).toBe(3);
  });
  it('handles quoted cells, commas inside them, CRLF and a byte order mark', () => {
    const r = parseAudienceCsv(
      '﻿email,first_name\r\n"a@b.co","Smith, ""Jo"""\r\n',
    );
    expect(r.people).toEqual([{ email: 'a@b.co', firstName: 'Smith, "Jo"' }]);
  });
  it('refuses a file with no email column or no content', () => {
    expect(() => parseAudienceCsv('name,phone\nAda,1')).toThrow(CsvFormatError);
    expect(() => parseAudienceCsv('')).toThrow(CsvFormatError);
  });
});

describe('EMAIL-01 audience plan (suppression and limit)', () => {
  const people = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
    email: `${n}@x.test`,
    firstName: null,
  }));
  it('sets suppressed people aside and never emails them', () => {
    const plan = planAudience(people, new Set(['b@x.test']));
    expect(plan.eligible.map((p) => p.email)).toEqual([
      'a@x.test',
      'c@x.test',
      'd@x.test',
      'e@x.test',
    ]);
    expect(plan.suppressed.map((p) => p.email)).toEqual(['b@x.test']);
  });
  it('applies the limit to people who can be emailed', () => {
    const plan = planAudience(people, new Set(['a@x.test']), 2);
    expect(plan.eligible.map((p) => p.email)).toEqual(['b@x.test', 'c@x.test']);
    expect(plan.suppressed.map((p) => p.email)).toEqual(['a@x.test']);
  });
});

describe('EMAIL-01 request rate cap', () => {
  it('never starts more than 8 requests in any one second', async () => {
    let clock = 1_000_000;
    const pacer = new RequestPacer(
      8,
      () => clock,
      async (ms) => {
        clock += ms;
      },
    );
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        await pacer.acquire();
        starts.push(clock);
      }),
    );
    expect(starts).toHaveLength(50);
    for (const s of starts) {
      const inWindow = starts.filter((t) => t >= s && t < s + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(8);
    }
    // 50 requests at 8 a second cannot finish in less than 6 seconds.
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThanOrEqual(
      6000,
    );
  });
});
