import { NO_DELIVERY, readDelivery } from '../bill-delivery';

/**
 * BILLS-09: where the token and the units come from in what Flutterwave answers.
 *
 * Documented (developer.flutterwave.com, v3 Bills): the purchase answer's `data.recharge_token`; the bill status
 * answer's `data.token` and `data.extra`. The pages name no units field, so units are read from `units` or from `extra`.
 */
describe('readDelivery', () => {
  it('reads the token from the purchase answer (recharge_token)', () => {
    expect(
      readDelivery({
        phone_number: '45021234567',
        amount: 5000,
        network: 'IKEDC PREPAID',
        code: '200',
        tx_ref: 'wawu-bill-1',
        reference: '247891569224',
        batch_reference: null,
        recharge_token: '4821 0937 5510 2286 7734',
        fee: 100,
      }),
    ).toEqual({ token: '4821 0937 5510 2286 7734', units: null });
  });

  it('reads the token from the bill status answer (token)', () => {
    expect(
      readDelivery({
        tx_ref: 'wawu-bill-1',
        amount: 5000,
        fee: 0,
        extra: null,
        flw_ref: null,
        token: '48210937551022867734',
      }),
    ).toEqual({ token: '48210937551022867734', units: null });
  });

  it('reads both from a text extra, labelled the way a prepaid biller writes them', () => {
    expect(
      readDelivery({ extra: 'Token: 4821-0937-5510-2286-7734 Units: 45.2' }),
    ).toEqual({
      token: '4821-0937-5510-2286-7734',
      units: '45.2',
    });
    expect(
      readDelivery({ extra: 'Your token 4821 0937 5510 2286 7734, 45.2 kWh' }),
    ).toEqual({
      token: '4821 0937 5510 2286 7734',
      units: '45.2',
    });
  });

  it('reads both from an object extra and from a one-element array', () => {
    expect(
      readDelivery({
        extra: { token: '12345678901234567890', units: '12.50' },
      }),
    ).toEqual({
      token: '12345678901234567890',
      units: '12.50',
    });
    expect(readDelivery([{ token: '12345678901234567890', units: 7 }])).toEqual(
      {
        token: '12345678901234567890',
        units: '7',
      },
    );
  });

  it('prefers the field over the text, and takes a label off the token', () => {
    expect(
      readDelivery({
        recharge_token: 'Token: 1111 2222 3333 4444 5555',
        extra: 'Token: 9999 9999 9999',
      }),
    ).toEqual({
      token: '1111 2222 3333 4444 5555',
      units: null,
    });
  });

  it('is null for every answer that has none: airtime, nulls, empty, odd types', () => {
    expect(
      readDelivery({
        recharge_token: null,
        token: null,
        extra: null,
        batch_reference: null,
      }),
    ).toEqual(NO_DELIVERY);
    expect(readDelivery({ status: 'successful', extra: '' })).toEqual(
      NO_DELIVERY,
    );
    expect(readDelivery({})).toEqual(NO_DELIVERY);
    expect(readDelivery(null)).toEqual(NO_DELIVERY);
    expect(readDelivery(undefined)).toEqual(NO_DELIVERY);
    expect(readDelivery('token 12345678')).toEqual(NO_DELIVERY);
    expect(readDelivery([])).toEqual(NO_DELIVERY);
    expect(
      readDelivery({ token: { value: '12345678901234567890' }, units: ['5'] }),
    ).toEqual(NO_DELIVERY);
  });

  it('refuses anything that is not a short plain token or a plain number of units', () => {
    expect(readDelivery({ token: '<script>alert(1)</script>' })).toEqual(
      NO_DELIVERY,
    );
    expect(readDelivery({ token: 'x'.repeat(200) })).toEqual(NO_DELIVERY);
    expect(readDelivery({ token: '123' })).toEqual(NO_DELIVERY);
    expect(readDelivery({ units: 'a lot' })).toEqual(NO_DELIVERY);
    expect(readDelivery({ units: '-4' })).toEqual(NO_DELIVERY);
    expect(readDelivery({ units: '1e9' })).toEqual(NO_DELIVERY);
  });
});
