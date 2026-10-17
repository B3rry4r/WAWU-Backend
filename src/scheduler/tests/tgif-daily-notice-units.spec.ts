// HOME-16: the decisions of the daily TGIF notice that need no database. The
// clock in Lagos, the set time, the words of the notice for every day of a leap
// year, where the notice sits in the push and notification tables, and the
// three runs that must not touch the database at all (too early, too late, a
// day with no TGIF).

import type { ConfigService } from '@nestjs/config';
import {
  composeNotification,
  NOTIFICATION_CATEGORY,
  targetFor,
  tgifSeriesTitle,
} from '../../notification/notification-event';
import { SETTINGS_GATE } from '../../notification/notification.service';
import type { NotificationService } from '../../notification/notification.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { PUSH_ONLY_GATE, PUSH_RULE, pushGateFor } from '../../push/push-policy';
import { TgifContentService } from '../../tgif/content/tgif-content.service';
import {
  LAGOS_UTC_OFFSET_MINUTES,
  TGIF_NOTICE_CATCH_UP_MINUTES,
  TGIF_NOTIFICATION_TIME_DEFAULT,
  parseNoticeTime,
} from '../tgif-daily-notice.config';
import {
  TgifDailyNoticeService,
  lagosClock,
} from '../tgif-daily-notice.service';

/** An em-dash or an en-dash, written as escapes so this file has none. */
const DASHES = new RegExp('[\\u2014\\u2013]');

const config = (value?: string) =>
  ({ get: () => value }) as unknown as ConfigService;

/** A prisma and notifications that fail the test if they are touched. */
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the database or the notifications were touched');
    },
  },
);

const service = (content: Pick<TgifContentService, 'day'>, value?: string) =>
  new TgifDailyNoticeService(
    untouchable as unknown as PrismaService,
    untouchable as unknown as NotificationService,
    content as TgifContentService,
    config(value),
  );

const book = new TgifContentService(config());

describe('the Lagos clock', () => {
  it('is one hour ahead of UTC all year', () => {
    expect(LAGOS_UTC_OFFSET_MINUTES).toBe(60);
    expect(lagosClock(new Date('2027-03-10T06:00:00Z'))).toEqual({
      day: '2027-03-10',
      minutes: 7 * 60,
    });
    expect(lagosClock(new Date('2027-07-01T06:59:59Z'))).toEqual({
      day: '2027-07-01',
      minutes: 7 * 60 + 59,
    });
  });

  it('turns over at 23:00 UTC', () => {
    expect(lagosClock(new Date('2027-03-10T22:59:00Z')).day).toBe('2027-03-10');
    expect(lagosClock(new Date('2027-03-10T23:00:00Z'))).toEqual({
      day: '2027-03-11',
      minutes: 0,
    });
  });
});

describe('the set time (tgif_notification_time)', () => {
  it('reads HH:MM and nothing else', () => {
    expect(parseNoticeTime('07:00')).toBe(420);
    expect(parseNoticeTime('00:00')).toBe(0);
    expect(parseNoticeTime('23:59')).toBe(23 * 60 + 59);
    for (const bad of [
      '7:00',
      '24:00',
      '07:60',
      '0700',
      '',
      'morning',
      7,
      null,
    ]) {
      expect(parseNoticeTime(bad)).toBeNull();
    }
  });

  it('is 07:00 when nothing is set, and when the setting is not a time', () => {
    expect(TGIF_NOTIFICATION_TIME_DEFAULT).toBe('07:00');
    expect(service(book, undefined).noticeMinutes()).toBe(420);
    expect(service(book, '').noticeMinutes()).toBe(420);
    expect(service(book, 'around eight').noticeMinutes()).toBe(420);
    expect(service(book, '09:30').noticeMinutes()).toBe(9 * 60 + 30);
  });
});

describe('a run that must not touch the database', () => {
  it('does nothing before the set time', async () => {
    const report = await service(book).run(new Date('2027-03-10T05:59:00Z'));
    expect(report).toEqual({ day: '2027-03-10', state: 'early', written: 0 });
  });

  it('does nothing once the catch-up window is over', async () => {
    const after = new Date(
      Date.parse('2027-03-10T06:00:00Z') +
        TGIF_NOTICE_CATCH_UP_MINUTES * 60_000,
    );
    expect(await service(book).run(after)).toEqual({
      day: '2027-03-10',
      state: 'late',
      written: 0,
    });
  });

  it('sends nothing on a day the book has no TGIF for', async () => {
    const empty = {
      day: () => {
        throw new Error('TGIF book 03.json is not month 3 in full');
      },
    };
    const report = await service(empty).run(new Date('2027-03-10T06:30:00Z'));
    expect(report).toEqual({ day: '2027-03-10', state: 'no_tgif', written: 0 });
  });
});

describe('the words of the notice', () => {
  it('sets a series in title case', () => {
    expect(
      [
        'THE EXCHANGE',
        'IDENTITY RESET',
        'SONS, NOT SLAVES',
        'THE RESURRECTION LIFE',
        'THE FINISHED WORK',
        'WHAT YOU HAVE IN CHRIST',
        'SEATED WITH CHRIST',
        'THE HOLY SPIRIT',
        'THE NEW CREATION',
        'FREE FROM…',
        'LIVING FROM IDENTITY',
        'THE HOPE OF GLORY',
      ].map(tgifSeriesTitle),
    ).toEqual([
      'The Exchange',
      'Identity Reset',
      'Sons, Not Slaves',
      'The Resurrection Life',
      'The Finished Work',
      'What You Have in Christ',
      'Seated with Christ',
      'The Holy Spirit',
      'The New Creation',
      'Free from…',
      'Living from Identity',
      'The Hope of Glory',
    ]);
  });

  it('carries the day title and verse for every day of a leap year, with no dash and room on a lock screen', () => {
    let days = 0;
    for (let t = Date.parse('2028-01-01T00:00:00Z'); ; t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      if (!date.startsWith('2028')) break;
      days += 1;
      const view = book.day(date, null);
      const draft = composeNotification({
        kind: 'tgif_daily',
        userWawuId: 'u',
        day: date,
        series: view.series,
        verseReference: view.verseReference,
      });
      expect(draft.kind).toBe('tgif_daily');
      expect(draft.title).toBe(`TGIF: ${tgifSeriesTitle(view.series)}`);
      expect(draft.body).toBe(`Today's TGIF is ready. ${view.verseReference}.`);
      expect(draft.title.length).toBeLessThanOrEqual(40);
      expect(draft.body.length).toBeLessThanOrEqual(80);
      expect(draft.title).not.toMatch(DASHES);
      expect(draft.body).not.toMatch(DASHES);
      expect(draft.tone).toBe('accent');
      expect(draft.amount).toBeNull();
      expect(draft.creditsCount).toBeNull();
      expect(draft.actionHref).toBeNull();
    }
    expect(days).toBe(366);
  });

  it('opens the day it was made for', () => {
    expect(
      targetFor({
        kind: 'tgif_daily',
        userWawuId: 'u',
        day: '2027-03-10',
        series: 'THE EXCHANGE',
        verseReference: 'Romans 8:15 (NIV)',
      }),
    ).toEqual({
      targetKind: 'tgif_day',
      targetId: '2027-03-10',
      actorWawuId: null,
    });
  });
});

describe('where the notice sits in the tables', () => {
  it('is a notification of the other group, pushed, and muted by the TGIF switch', () => {
    expect(NOTIFICATION_CATEGORY.tgif_daily).toBe('other');
    expect(PUSH_RULE.tgif_daily).toBe('send');
    expect(SETTINGS_GATE.tgif_daily).toBe('tgifDaily');
    expect(pushGateFor('tgif_daily')).toBe('tgifDaily');
    // Merge of HOME-16 and WALLET-39: the push-only map also holds WALLET-39's
    // correction of a money-in notice (the same pair push-policy.spec.ts pins).
    expect(PUSH_ONLY_GATE).toEqual({
      dm_received: 'dmReminders',
      money_in_reversed: 'moneyIn',
    });
  });
});
