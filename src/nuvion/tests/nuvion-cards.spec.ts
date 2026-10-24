import {
  cardExpiry,
  e164,
  readCard,
  readCardTransaction,
} from '../areas/cards';

/**
 * WALLET-31: the readers of Nuvion's card objects (api-reference__cards.md and
 * the dev answers of 24 Oct 2026). The routes themselves are walked against a
 * stood-in Nuvion in src/money/cards/tests/money-cards.contract.spec.ts.
 */
describe('WALLET-31: reading Nuvion card objects', () => {
  it('a card row is read field by field and never carries the number or the CVV', () => {
    const card = readCard({
      id: '01HXYZ9012ABCDEFGHJKMNPQRS',
      status: 'active',
      name: 'wawu-card-ab12cd34ef56',
      type: 'disposable',
      number: '4111111111111234',
      cvv: '123',
      currency: 'usd',
      last4: '1234',
    });
    expect(card).toEqual({
      id: '01HXYZ9012ABCDEFGHJKMNPQRS',
      type: 'single_use',
      name: 'wawu-card-ab12cd34ef56',
      status: 'active',
      currency: 'USD',
      last4: '1234',
    });
    expect(JSON.stringify(card)).not.toContain('4111111111111234');
    expect(JSON.stringify(card)).not.toContain('123"');
  });

  it('a create answer has no type: the kind asked for is used; a bad last4, an unknown status and a path-like id are refused', () => {
    expect(
      readCard(
        { id: '01HXYZ9012ABCDEFGHJKMNPQRS', status: 'active' },
        'virtual',
      ),
    ).toMatchObject({ type: 'virtual', last4: null });
    expect(
      readCard({
        id: '01HXYZ9012ABCDEFGHJKMNPQRS',
        status: 'active',
        last4: '12',
      }),
    ).toMatchObject({ last4: null });
    expect(
      readCard({ id: '01HXYZ9012ABCDEFGHJKMNPQRS', status: 'gone' }),
    ).toBeNull();
    expect(readCard({ id: '../x', status: 'active' })).toBeNull();
    expect(readCard(null)).toBeNull();
  });

  it('a card payment, a reversal and a refund are read; other payment types are left out', () => {
    const base = {
      _id: '01HXYZ0057ABCDEFGHJKMNPQRS',
      amount: 728,
      currency: 'USD',
      status: 'successful',
      narration: 'Payment to Acme Corp',
      recipient: {
        name: 'Acme Corp',
        address: { city: 'San Francisco', country: 'US' },
      },
      created: 1788190545125,
    };
    expect(
      readCardTransaction({ ...base, payment_type: 'card-debit' }),
    ).toMatchObject({
      kind: 'purchase',
      amountMinor: 728,
      merchant: 'Acme Corp',
      place: 'San Francisco, US',
    });
    expect(
      readCardTransaction({ ...base, payment_type: 'card-debit-reversal' }),
    ).toMatchObject({ kind: 'reversal', merchant: null });
    expect(
      readCardTransaction({ ...base, payment_type: 'card-credit-refund' }),
    ).toMatchObject({ kind: 'refund' });
    expect(
      readCardTransaction({ ...base, payment_type: 'bank-transfer' }),
    ).toBeNull();
    expect(
      readCardTransaction({ ...base, payment_type: 'card-debit', amount: 7.5 }),
    ).toBeNull();
  });

  it('the expiry is two years at most from now, as MM and YY', () => {
    expect(cardExpiry(new Date(Date.UTC(2026, 9, 24)))).toEqual({
      month: '09',
      year: '28',
    });
    expect(cardExpiry(new Date(Date.UTC(2026, 11, 31)))).toEqual({
      month: '11',
      year: '28',
    });
  });

  it('a phone number becomes E.164, or nothing', () => {
    expect(e164('+2348012345678')).toBe('+2348012345678');
    expect(e164('08012345678')).toBe('+2348012345678');
    expect(e164('2348012345678')).toBe('+2348012345678');
    expect(e164('080 1234 5678')).toBe('+2348012345678');
    expect(e164('12345')).toBeNull();
    expect(e164(null)).toBeNull();
  });
});
