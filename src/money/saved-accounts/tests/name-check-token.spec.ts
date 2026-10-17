import type { FeeSettings } from '../../fees/fee-config';
import {
  NAME_CHECK_TOKEN_MS,
  NameCheckTokenService,
} from '../name-check-token.service';

/**
 * Which name tokens a send to an account that is not saved may carry without
 * spending a name check (WALLET-37 round 5): only one this person got for
 * this bank code and account number, not past its time. The holder's name is
 * `matches`, which needs the bank's answer.
 */

const service = new NameCheckTokenService({
  quoteKey: () => Buffer.from('w37-test-name-token-key-0123456789ab'),
} as unknown as FeeSettings);
const shown = {
  bankCode: '000013',
  bankName: 'GUARANTY TRUST BANK',
  accountNumber: '0123456789',
  accountName: 'ADA SANDBOX',
};
const at = new Date('2026-10-17T10:00:00Z');

describe('NameCheckTokenService.issuedFor', () => {
  const token = service.issue('ada', shown, at);

  it('is true for the person, bank code and account number it was issued for', () => {
    expect(service.issuedFor(token, 'ada', '000013', '0123456789', at)).toBe(
      true,
    );
  });

  it('is false for another person, another bank code or account number, and a name that was never there', () => {
    expect(service.issuedFor(token, 'simi', '000013', '0123456789', at)).toBe(
      false,
    );
    expect(service.issuedFor(token, 'ada', '000014', '0123456789', at)).toBe(
      false,
    );
    expect(service.issuedFor(token, 'ada', '000013', '0123456780', at)).toBe(
      false,
    );
  });

  it('is false once the token is old, and the second before it is not', () => {
    const last = new Date(at.getTime() + NAME_CHECK_TOKEN_MS - 1);
    const over = new Date(at.getTime() + NAME_CHECK_TOKEN_MS);
    expect(service.issuedFor(token, 'ada', '000013', '0123456789', last)).toBe(
      true,
    );
    expect(service.issuedFor(token, 'ada', '000013', '0123456789', over)).toBe(
      false,
    );
  });

  it('is false for no token, text that is not a token, a changed token and one signed with another key', () => {
    const other = new NameCheckTokenService({
      quoteKey: () => Buffer.from('another-key-another-key-another-key!'),
    } as unknown as FeeSettings).issue('ada', shown, at);
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'x',
      'a.b',
      `${token}.extra`,
      `${token}A`,
      other,
    ]) {
      expect(service.issuedFor(bad, 'ada', '000013', '0123456789', at)).toBe(
        false,
      );
    }
  });

  it('does not look at the name: a token for a name the bank no longer gives is still this check, and matches says it is not the same name', () => {
    expect(service.issuedFor(token, 'ada', '000013', '0123456789', at)).toBe(
      true,
    );
    expect(
      service.matches(
        token,
        'ada',
        { ...shown, accountName: 'SOMEONE ELSE' },
        at,
      ),
    ).toBe(false);
  });
});
