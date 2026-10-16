import {
  FintavaWebhookProcessing,
  NuvionWebhookProcessing,
} from '../../../generated/prisma/client';
import {
  clearableStates,
  heldStates,
  WEBHOOK_RETENTION_CONFIG_KEYS,
  WEBHOOK_RETENTION_DEFAULTS,
  WEBHOOK_RETENTION_SCHEDULE,
  WEBHOOK_STATE_RULES,
  webhookRetentionMs,
} from '../webhook-retention-config';

const DAY = 86_400_000;

describe('FIX-20: the retention period is a setting', () => {
  it('is 90 days when left empty, unset or blank', () => {
    expect(webhookRetentionMs(undefined)).toBe(90 * DAY);
    expect(webhookRetentionMs('')).toBe(90 * DAY);
    expect(webhookRetentionMs('   ')).toBe(90 * DAY);
    expect(WEBHOOK_RETENTION_DEFAULTS.days).toBe(90);
  });

  it('takes a whole number of days from 7 to 3650, with spaces trimmed', () => {
    expect(webhookRetentionMs('7')).toBe(7 * DAY);
    expect(webhookRetentionMs('30')).toBe(30 * DAY);
    expect(webhookRetentionMs(' 365 ')).toBe(365 * DAY);
    expect(webhookRetentionMs('3650')).toBe(3650 * DAY);
  });

  it.each([
    '6',
    '0',
    '-1',
    '3651',
    '1.5',
    '90.0',
    '1e2',
    '0x5A',
    '+90',
    '90 days',
    'ninety',
    '9 0',
  ])('refuses %j and names the setting, with no em-dash', (raw) => {
    let message = '';
    try {
      webhookRetentionMs(raw);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(WEBHOOK_RETENTION_CONFIG_KEYS.days);
    expect(message).toContain('from 7 to 3650');
    expect(message).not.toContain('—');
  });

  it('is a daily job at a fixed time, named', () => {
    expect(WEBHOOK_RETENTION_SCHEDULE).toEqual({
      name: 'webhook-retention',
      cron: '0 40 2 * * *',
    });
  });

  it('bounds a run: 200 rows a statement, ten minutes', () => {
    expect(WEBHOOK_RETENTION_DEFAULTS.batch).toBe(200);
    expect(WEBHOOK_RETENTION_DEFAULTS.budgetMs).toBe(600_000);
  });
});

describe('FIX-20: which states are cleared and which are held', () => {
  it('classifies every state of both tables (the type already refuses a missing one)', () => {
    expect(Object.keys(WEBHOOK_STATE_RULES.FintavaWebhookEvent).sort()).toEqual(
      Object.values(FintavaWebhookProcessing).sort(),
    );
    expect(Object.keys(WEBHOOK_STATE_RULES.NuvionWebhookEvent).sort()).toEqual(
      Object.values(NuvionWebhookProcessing).sort(),
    );
  });

  it('clears a processed delivery, and a Nuvion test delivery, and nothing else', () => {
    expect(clearableStates('FintavaWebhookEvent')).toEqual(['processed']);
    expect(clearableStates('NuvionWebhookEvent').sort()).toEqual([
      'processed',
      'test',
    ]);
  });

  it('holds what a reader may still need: pending, failed and unrecognised, on both tables', () => {
    expect(heldStates('FintavaWebhookEvent').sort()).toEqual([
      'failed',
      'pending',
      'unrecognised',
    ]);
    expect(heldStates('NuvionWebhookEvent').sort()).toEqual([
      'failed',
      'pending',
      'unrecognised',
    ]);
  });

  it('says why for every state, in words with no em-dash', () => {
    for (const table of [
      WEBHOOK_STATE_RULES.FintavaWebhookEvent,
      WEBHOOK_STATE_RULES.NuvionWebhookEvent,
    ] as Array<Record<string, { why: string }>>) {
      for (const rule of Object.values(table)) {
        expect(rule.why.length).toBeGreaterThan(20);
        expect(rule.why).not.toContain('—');
      }
    }
  });
});
