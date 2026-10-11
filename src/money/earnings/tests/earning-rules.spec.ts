import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import { providerLimitError } from '../../../wallet-provider/wallet-provider-limit';
import { decodeEarningCursor, encodeEarningCursor } from '../earning-cursor';
import {
  earningReference,
  NOT_SETTLED_HERE,
  waitingAfterRefusal,
} from '../earning-rules';
import { currentLagosMonth } from '../earnings-view.service';
import { HELD_PAYMENT_KINDS } from '../../dto/money-enums';

const error = (
  kind: ConstructorParameters<typeof WalletProviderError>[0]['kind'],
  extra: { requestNotSent?: boolean; recordMayExist?: boolean } = {},
) =>
  new WalletProviderError({
    kind,
    provider: 'fintava',
    operation: 'wallet to wallet',
    ...extra,
  });

describe('the rules of an earning landing (WALLET-16)', () => {
  const id = '6f1c9b7e-2f1c-4b1e-9b7e-2f1c9b7e2f1c';

  it('names the move after the sale: one sale, one reference, inside the 64 Nuvion allows', () => {
    expect(earningReference(id, 1)).toBe(`wawu-earn-${id}`);
    expect(earningReference(id, 1)).toHaveLength(46);
    expect(earningReference(id, 2)).toBe(`wawu-earn-${id}-2`);
    expect(earningReference(id, 9).length).toBeLessThanOrEqual(64);
    // The same sale always has the same first reference, however many ask.
    expect(earningReference(id, 1)).toBe(earningReference(id, 1));
    expect(earningReference(id, 1)).not.toBe(
      earningReference('6f1c9b7e-2f1c-4b1e-9b7e-2f1c9b7e2f1d', 1),
    );
  });

  it('leaves every held kind to the hold’s release', () => {
    expect([...NOT_SETTLED_HERE].sort()).toEqual(
      [...HELD_PAYMENT_KINDS].sort(),
    );
    expect(NOT_SETTLED_HERE).toEqual(
      expect.arrayContaining(['paid_dm', 'event_ticket', 'bill']),
    );
  });

  describe('why a refused move waits', () => {
    it.each([
      ['insufficient_funds', 'funds', true],
      ['wallet_inactive', 'recipient_frozen', false],
      ['not_supported', 'not_supported', true],
      ['auth', 'provider', false],
      ['not_configured', 'provider', false],
      ['merchant_inactive', 'provider', false],
      ['rate_limited', 'provider', false],
      ['unavailable', 'provider', false],
      ['bad_response', 'provider', false],
      ['refused', 'refused', true],
      ['validation', 'refused', true],
    ] as const)('%s waits as %s', (kind, waiting, loud) => {
      expect(waitingAfterRefusal(error(kind))).toEqual({ waiting, loud });
    });

    it('reads a request that never reached the provider as the provider being away, whatever the kind', () => {
      expect(
        waitingAfterRefusal(
          error('outcome_unknown', {
            requestNotSent: true,
            recordMayExist: true,
          }),
        ),
      ).toEqual({ waiting: 'provider', loud: false });
    });

    it('reads one of the provider’s own limits as the provider, not a refusal for a person to look at', () => {
      const limit = providerLimitError(
        'nuvion',
        'error_transfer_daily_limit_exceeded',
        { operation: 'book transfer' },
      );
      expect(limit).not.toBeNull();
      expect(waitingAfterRefusal(limit!)).toEqual({
        waiting: 'provider',
        loud: false,
      });
    });
  });

  describe('the cursor', () => {
    const cursor = {
      month: '2026-10',
      earnedKobo: 170_000n,
      kind: 'content_unlock' as const,
      targetId: 'unlock-6f1c9b7e',
    };

    it('comes back as it went', () => {
      const raw = encodeEarningCursor(cursor);
      expect(raw.startsWith('e1.')).toBe(true);
      expect(decodeEarningCursor(raw)).toEqual(cursor);
      // A figure beyond a safe number is still exact.
      const big = { ...cursor, earnedKobo: 9_007_199_254_740_993n };
      expect(decodeEarningCursor(encodeEarningCursor(big)).earnedKobo).toBe(
        9_007_199_254_740_993n,
      );
    });

    it.each([
      ['not ours', 'x1.AAAA'],
      ['not base64 json', 'e1.%%%'],
      ['not an array', `e1.${Buffer.from('{}').toString('base64url')}`],
      [
        'a month that is not one',
        `e1.${Buffer.from(JSON.stringify(['2026-13', '1', 'tip', 'x'])).toString('base64url')}`,
      ],
      [
        'year zero',
        `e1.${Buffer.from(JSON.stringify(['0000-01', '1', 'tip', 'x'])).toString('base64url')}`,
      ],
      [
        'a figure that is not whole kobo',
        `e1.${Buffer.from(JSON.stringify(['2026-10', '-1', 'tip', 'x'])).toString('base64url')}`,
      ],
      [
        'a kind nobody sells',
        `e1.${Buffer.from(JSON.stringify(['2026-10', '1', 'gold', 'x'])).toString('base64url')}`,
      ],
      [
        'a target with a quote in it',
        `e1.${Buffer.from(JSON.stringify(['2026-10', '1', 'tip', "x'; DROP"])).toString('base64url')}`,
      ],
    ])('refuses %s', (_why, raw) => {
      expect(() => decodeEarningCursor(raw)).toThrow(
        'cursor is not one this list gave.',
      );
    });
  });

  describe('which month is this month', () => {
    it('is the month Nigerians live by: Lagos midnight, not UTC', () => {
      // 30 Sep 23:30 UTC is 00:30 on 1 Oct in Lagos.
      expect(currentLagosMonth(new Date('2026-09-30T23:30:00Z'))).toBe(
        '2026-10',
      );
      expect(currentLagosMonth(new Date('2026-09-30T22:59:59Z'))).toBe(
        '2026-09',
      );
      expect(currentLagosMonth(new Date('2026-12-31T23:00:00Z'))).toBe(
        '2027-01',
      );
    });
  });
});
