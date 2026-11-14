import { renderEmail } from '../email-render';
import {
  readUnsubscribeToken,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../email-unsubscribe';
import { checkSvix, parseResendEvent, svixSign } from '../email-webhook';
import { WawuIdMailRelay, ResendClient } from '../email-provider';
import { nextUtcMidnight } from '../email-sending.service';
import { MAX_SENDS_PER_SECOND, voicesApi } from '../email-config';
import { assertButtonPair } from '../dto/email.dto';

const UNSUB = 'https://hub.example.test/api/hub/email/unsubscribe?t=a.b';
const BASE = {
  subject: 'Hi {{first_name}}',
  previewText: 'Peek',
  body: 'Hello **{{first_name}}**, see [the page](https://example.com/a?x=1&y=2).\n\nOpen {{app_link}} or {{join_link}}.',
  firstName: 'Ada',
  unsubscribeUrl: UNSUB,
};

describe('EMAIL-03 rendering, both looks', () => {
  it('wmt: placeholders fill with the Who Made This address, links stay links', () => {
    const m = renderEmail({ ...BASE, brand: 'wmt' });
    expect(m.html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(m.html).toContain('Open https://usewmt.com or https://usewmt.com.');
    expect(m.text).toContain('the page (https://example.com/a?x=1&y=2)');
    expect(m.html).toContain('who-made-this-white.png');
    expect(m.html).not.toContain('usevoices.com');
  });

  it('voices: the Voices look, words, logo, colours and placeholders', () => {
    const m = renderEmail({ ...BASE, brand: 'voices' });
    expect(m.html).toContain(
      'https://id.wawuafrica.com/assets/voices/logo-wordmark-white.png',
    );
    expect(m.html).toContain('#002B1A');
    expect(m.html).toContain('Rowdies');
    expect(m.html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(m.html).toContain(
      'Open https://usevoices.com or https://usevoices.com.',
    );
    expect(m.html).toContain('Voices by WAWU');
    expect(m.html).toContain(`href="${UNSUB}"`);
    expect(m.html).not.toContain('who-made-this-white.png');
    expect(m.text).toContain(`Unsubscribe: ${UNSUB}`);
    expect(m.text).toContain('Voices');
    expect(m.html + m.text).not.toMatch(/[—–]/);
  });

  it('the button is a real link in the brand colour, and a line in the text', () => {
    const wmt = renderEmail({
      ...BASE,
      brand: 'wmt',
      button: { text: 'Open the app', url: 'https://usewmt.com/x' },
    });
    expect(wmt.html).toContain('background:#9411C9');
    expect(wmt.html).toContain('href="https://usewmt.com/x"');
    expect(wmt.html).toContain('>Open the app</a>');
    expect(wmt.text).toContain('Open the app: https://usewmt.com/x');
    const v = renderEmail({
      ...BASE,
      brand: 'voices',
      button: { text: 'Hear it', url: '{{app_link}}/today' },
    });
    expect(v.html).toContain('background:#0DA86A');
    expect(v.html).toContain('href="https://usevoices.com/today"');
    expect(v.text).toContain('Hear it: https://usevoices.com/today');
  });

  it('a button that is not http(s) is dropped, never drawn', () => {
    const m = renderEmail({
      ...BASE,
      brand: 'voices',
      button: { text: 'Bad', url: 'javascript:alert(1)' },
    });
    expect(m.html).not.toContain('javascript');
    expect(m.text).not.toContain('Bad:');
  });

  it('both button fields or neither', () => {
    expect(() => assertButtonPair('Go', undefined)).toThrow();
    expect(() => assertButtonPair(null, 'https://x.co')).toThrow();
    expect(() => assertButtonPair('Go', 'https://x.co')).not.toThrow();
    expect(() => assertButtonPair(undefined, null)).not.toThrow();
  });
});

describe('EMAIL-03 unsubscribe tokens carry the brand', () => {
  const SECRET = 'a-secret-that-is-at-least-thirty-two-chars';
  it('an old two-part token still means wmt; a voices token reads as voices', () => {
    const old = signUnsubscribeToken('a@b.co', SECRET);
    expect(old.split('.')).toHaveLength(2);
    expect(readUnsubscribeToken(old, SECRET)).toEqual({
      email: 'a@b.co',
      brand: 'wmt',
    });
    const v = signUnsubscribeToken('a@b.co', SECRET, 'voices');
    expect(readUnsubscribeToken(v, SECRET)).toEqual({
      email: 'a@b.co',
      brand: 'voices',
    });
    expect(verifyUnsubscribeToken(v, SECRET)).toBe('a@b.co');
  });
  it('a brand cannot be added to or dropped from a token', () => {
    const old = signUnsubscribeToken('a@b.co', SECRET);
    expect(readUnsubscribeToken(`${old}.voices`, SECRET)).toBeNull();
    const v = signUnsubscribeToken('a@b.co', SECRET, 'voices');
    expect(
      readUnsubscribeToken(v.split('.').slice(0, 2).join('.'), SECRET),
    ).toBeNull();
    expect(readUnsubscribeToken(`${old}.other`, SECRET)).toBeNull();
  });
});

describe('EMAIL-03 Svix signature check', () => {
  const secret = `whsec_${Buffer.from('test-signing-key-123').toString('base64')}`;
  const body = Buffer.from('{"type":"email.delivered"}');
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const good = svixSign(secret, 'msg_1', ts, body);
  const check = (over: object = {}) =>
    checkSvix({
      secret,
      id: 'msg_1',
      timestamp: ts,
      signature: good,
      rawBody: body,
      nowMs: now,
      ...over,
    });
  it('accepts a good signature, also among several', () => {
    expect(check()).toBe('ok');
    expect(check({ signature: `v1,AAAA ${good}` })).toBe('ok');
  });
  it('refuses a bad signature, a changed body, a changed id', () => {
    expect(check({ signature: 'v1,AAAAAAAA' })).toBe('bad_signature');
    expect(check({ rawBody: Buffer.from('{"type":"x"}') })).toBe(
      'bad_signature',
    );
    expect(check({ id: 'msg_2' })).toBe('bad_signature');
  });
  it('refuses a timestamp more than five minutes old or ahead', () => {
    const old = String(Math.floor(now / 1000) - 301);
    expect(
      check({
        timestamp: old,
        signature: svixSign(secret, 'msg_1', old, body),
      }),
    ).toBe('bad_timestamp');
    const ahead = String(Math.floor(now / 1000) + 301);
    expect(
      check({
        timestamp: ahead,
        signature: svixSign(secret, 'msg_1', ahead, body),
      }),
    ).toBe('bad_timestamp');
    expect(check({ timestamp: 'abc' })).toBe('bad_timestamp');
  });
});

describe('EMAIL-03 reading a Resend event', () => {
  it('knows a permanent bounce from a transient one', () => {
    const e = (type: string) =>
      parseResendEvent(
        {
          type: 'email.bounced',
          created_at: '2026-11-13T10:00:00Z',
          data: {
            email_id: 'p1',
            to: ['A@B.co'],
            bounce: { type, message: 'No such user' },
          },
        },
        new Date(),
      );
    expect(e('Permanent')).toMatchObject({
      providerId: 'p1',
      email: 'a@b.co',
      delivery: 'bounced',
      permanentBounce: true,
      note: 'No such user',
    });
    expect(e('Transient')?.permanentBounce).toBe(false);
    expect(
      parseResendEvent({ type: 'email.opened', data: {} }, new Date())
        ?.delivery,
    ).toBeNull();
    expect(parseResendEvent('x', new Date())).toBeNull();
  });
});

describe('EMAIL-03 the relay says a limit, not a bad message', () => {
  const cfg = {
    get: (k: string) =>
      ({
        WAWU_ID_BASE_URL: 'http://relay.invalid',
        WAWU_ID_INTERNAL_SERVICE_KEY: 'k',
      })[k],
  };
  const relay = new WawuIdMailRelay(cfg as never);
  const msg = {
    from: 'x',
    to: 'a@b.co',
    subject: 's',
    html: 'h',
    text: 't',
    headers: {},
    idempotencyKey: 'k1',
  };
  afterEach(() => jest.restoreAllMocks());
  const answer = (status: number, body: object) =>
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it.each([
    ['daily_cap', 'daily_cap'],
    ['provider_daily_quota', 'provider_daily_quota'],
    ['provider_monthly_quota', 'provider_monthly_quota'],
    ['MAIL_DAILY_CAP', 'daily_cap'],
    [undefined, 'daily_cap'],
    ['something_new', 'daily_cap'],
  ])(
    '429 with code %s pauses as %s, never retried, never a failure',
    async (code, pause) => {
      const spy = answer(429, { statusCode: 429, code, message: 'Limit.' });
      const r = await relay.send(msg);
      expect(r).toMatchObject({ ok: false, transient: false, pause });
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it('a 503 is still a retry and carries no pause', async () => {
    answer(503, { message: 'busy' });
    expect(await relay.send(msg)).toMatchObject({ ok: false, transient: true });
    expect(await relay.send(msg)).not.toHaveProperty('pause');
  });

  it('sends app: voices only for a voices message', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"id":"m1"}', { status: 200 }));
    await relay.send({ ...msg, app: 'voices' });
    await relay.send(msg);
    const bodies = spy.mock.calls.map(
      (c) =>
        JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>,
    );
    expect(bodies[0].app).toBe('voices');
    expect('app' in bodies[1]).toBe(false);
  });

  it('Resend direct: provider quotas pause, a rate limit still retries', async () => {
    const resend = new ResendClient({
      get: (k: string) => (k === 'RESEND_API_KEY' ? 're_x' : undefined),
    } as never);
    answer(429, { name: 'daily_quota_exceeded', message: 'q' });
    expect(await resend.send(msg)).toMatchObject({
      pause: 'provider_daily_quota',
    });
    answer(429, { name: 'monthly_quota_exceeded', message: 'q' });
    expect(await resend.send(msg)).toMatchObject({
      pause: 'provider_monthly_quota',
    });
    answer(429, { name: 'rate_limit_exceeded', message: 'q' });
    expect(await resend.send(msg)).toMatchObject({ transient: true });
  });
});

describe('EMAIL-03 figures and settings', () => {
  it('sends at most 5 a second', () => expect(MAX_SENDS_PER_SECOND).toBe(5));
  it('next midnight is 00:00 UTC of the next day', () => {
    expect(
      nextUtcMidnight(new Date('2026-11-13T23:59:59Z')).toISOString(),
    ).toBe('2026-11-14T00:00:00.000Z');
    expect(
      nextUtcMidnight(new Date('2026-12-31T00:00:00Z')).toISOString(),
    ).toBe('2027-01-01T00:00:00.000Z');
  });
  it('voices is available only with both settings; the base keeps its /api/v1', () => {
    const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
    expect(voicesApi(env({}))).toBeNull();
    expect(
      voicesApi(env({ VOICES_API_BASE_URL: 'https://v.test/api/v1' })),
    ).toBeNull();
    expect(
      voicesApi(
        env({
          VOICES_API_BASE_URL: 'https://v.test/api/v1/',
          VOICES_INTERNAL_SERVICE_KEY: 'k',
        }),
      ),
    ).toEqual({ base: 'https://v.test/api/v1', key: 'k' });
  });
});
