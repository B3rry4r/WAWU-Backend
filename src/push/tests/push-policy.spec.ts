// INBOX-03: the decisions that need no database. Which kinds reach a phone,
// that the words are the notification's own and free of em-dashes, the payload
// limit, and the kill switch's reading of the environment.

import {
  composeNotification,
  NOTIFICATION_CATEGORY,
  type NotificationEvent,
  type NotificationKind,
} from '../../notification/notification-event';
import { SETTINGS_GATE } from '../../notification/notification.service';
import {
  EXPO_MAX_PAYLOAD_BYTES,
  EXPO_TOKEN_PATTERN,
  PushConfigError,
  loadPushSettings,
} from '../push-config';
import { buildMessage } from '../push-message';
import {
  PUSH_ONLY_GATE,
  PUSH_RULE,
  pushGateFor,
  pushedKinds,
} from '../push-policy';

const ALL_KINDS = Object.keys(NOTIFICATION_CATEGORY) as NotificationKind[];

/** An em-dash or an en-dash, written as escapes so this file has none. */
const DASHES = new RegExp('[\\u2014\\u2013]');

describe('which notifications reach a phone', () => {
  it('decides every kind there is, and names none that is not', () => {
    expect(Object.keys(PUSH_RULE).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('pushes a kind only if a Z3 switch can mute it, or it is on the short list the owner has to confirm', () => {
    const ungatedButSent = pushedKinds().filter((k) => !pushGateFor(k));
    expect(ungatedButSent.sort()).toEqual([
      'community_join_approved',
      'community_join_declined',
    ]);
  });

  it('holds back every kind that has no agreed switch, and the marketing send', () => {
    const held = ALL_KINDS.filter((k) => PUSH_RULE[k] === 'hold').sort();
    expect(held).toEqual([
      'campaign',
      'credits_low',
      'kyc_verified',
      'paid_dm_paused',
      'paid_dm_warning',
      'verify_reminder',
    ]);
  });

  it("uses the notification service's own gate map, and adds only the one push-only entry", () => {
    for (const kind of Object.keys(SETTINGS_GATE) as NotificationKind[]) {
      expect(pushGateFor(kind)).toBe(
        PUSH_ONLY_GATE[kind] ?? SETTINGS_GATE[kind],
      );
    }
    expect(PUSH_ONLY_GATE).toEqual({ dm_received: 'dmReminders' });
    expect(SETTINGS_GATE.dm_received).toBeUndefined(); // the list is unchanged for the web
  });
});

const EVENTS: NotificationEvent[] = [
  {
    kind: 'sale',
    userWawuId: 'u',
    contentTitle: 'Night shoot',
    netAmount: 8500,
  },
  { kind: 'tip_received', userWawuId: 'u', netAmount: 850 },
  { kind: 'dm_received', userWawuId: 'u', amount: 2000 },
  { kind: 'dm_deadline', userWawuId: 'u', hoursLeft: 3 },
  { kind: 'dm_refunded', userWawuId: 'u', amount: 2000 },
  { kind: 'new_follower', userWawuId: 'u' },
  { kind: 'content_published', userWawuId: 'u', contentTitle: 'Night shoot' },
  {
    kind: 'content_rejected',
    userWawuId: 'u',
    contentTitle: 'Night shoot',
    reason: 'Too dark.',
  },
  {
    kind: 'review_received',
    userWawuId: 'u',
    contentTitle: 'Night shoot',
    stars: 5,
  },
  {
    kind: 'community_join_approved',
    userWawuId: 'u',
    communityId: 'c',
    communityName: 'Lagos Makers',
  },
  {
    kind: 'community_join_declined',
    userWawuId: 'u',
    communityName: 'Lagos Makers',
  },
];

describe('the words of a push', () => {
  it('has an example for every kind that is pushed', () => {
    expect(EVENTS.map((e) => e.kind).sort()).toEqual([...pushedKinds()].sort());
  });

  it.each(EVENTS.map((e) => [e.kind, e] as const))(
    '%s: title and body carry no em-dash or en-dash',
    (_k, event) => {
      const draft = composeNotification(event);
      expect(draft.title).not.toMatch(DASHES);
      expect(draft.body).not.toMatch(DASHES);
    },
  );

  it("is the notification's own title and body, with where it opens and what it is about, and no token", () => {
    const token = 'ExponentPushToken[abc]';
    const message = buildMessage(
      {
        id: 'n1',
        kind: 'tip_received',
        title: 'You received a tip',
        body: 'Someone tipped you.',
        actionHref: null,
        target: { targetKind: 'profile', targetId: 'p1' },
      },
      token,
    );
    expect(message).toMatchObject({
      to: token,
      title: 'You received a tip',
      body: 'Someone tipped you.',
    });
    expect(message.data).toEqual({
      notificationId: 'n1',
      kind: 'tip_received',
      target: { kind: 'profile', id: 'p1' },
    });
    expect(JSON.stringify(message.data)).not.toContain(token);
    expect(message.ttl).toBeGreaterThan(0);
  });

  it("is cut to Expo's payload limit by shortening the body, never the data the app needs", () => {
    const message = buildMessage(
      {
        id: 'n1',
        kind: 'campaign',
        title: 'T',
        body: 'é'.repeat(6000),
        actionHref: '/explore',
        target: null,
      },
      'ExponentPushToken[abc]',
    );
    expect(
      Buffer.byteLength(JSON.stringify(message), 'utf8'),
    ).toBeLessThanOrEqual(EXPO_MAX_PAYLOAD_BYTES);
    expect(message.body.length).toBeGreaterThan(100);
    expect(message.data).toMatchObject({
      notificationId: 'n1',
      actionHref: '/explore',
    });
  });
});

describe('push settings', () => {
  it('is off unless PUSH_ENABLED is exactly true', () => {
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'yes', ' no ']) {
      expect(loadPushSettings({ PUSH_ENABLED: v }).on).toBe(false);
    }
    expect(loadPushSettings({ PUSH_ENABLED: 'true' }).on).toBe(true);
    expect(loadPushSettings({ PUSH_ENABLED: ' true ' }).on).toBe(true);
  });

  it("defaults to Expo's host, takes an optional access token, and trims it", () => {
    const s = loadPushSettings({ EXPO_ACCESS_TOKEN: '  abc  ' });
    expect(s.baseUrl).toBe('https://exp.host');
    expect(s.accessToken).toBe('abc');
    expect(loadPushSettings({}).accessToken).toBeNull();
  });

  it("refuses a base URL that is not Expo's own host over https or a local address", () => {
    for (const bad of [
      'http://exp.host',
      'https://evil.example',
      'https://exp.host.evil.example',
      'not a url',
      'https://127.0.0.2',
      'ftp://exp.host',
    ]) {
      expect(() => loadPushSettings({ EXPO_PUSH_BASE_URL: bad })).toThrow(
        PushConfigError,
      );
    }
    for (const good of [
      'https://exp.host',
      'https://exp.host/',
      'http://127.0.0.1:4010',
      'http://localhost:4010',
    ]) {
      expect(() =>
        loadPushSettings({ EXPO_PUSH_BASE_URL: good }),
      ).not.toThrow();
    }
  });
});

describe('the token format', () => {
  it.each([
    'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    'ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  ])('accepts %s', (t) => {
    expect(EXPO_TOKEN_PATTERN.test(t)).toBe(true);
  });
  it.each([
    '',
    'ExponentPushToken[]',
    'ExponentPushToken[a b]',
    'ExponentPushToken[a]b',
    'xExponentPushToken[a]',
    'ExponentPushToken[a\n]',
    'fcm-token',
    'ExpoPushToken[a]]',
  ])('refuses %j', (t) => {
    expect(EXPO_TOKEN_PATTERN.test(t)).toBe(false);
  });
});
