import { WalletProviderError } from '../wallet-provider-error';

const STILL_CONFIRMING =
  'We are still confirming this payment. Check your history before you try again.';
const NOT_AVAILABLE =
  'Payments are not available right now. Try again in a moment.';

const error = (
  requestNotSent: boolean,
  kind: 'outcome_unknown' | 'not_confirmed' = 'outcome_unknown',
) =>
  new WalletProviderError({
    kind,
    provider: 'nuvion',
    operation: 'bank transfer',
    requestNotSent,
  });

describe('what a provider failure is answered with', () => {
  it('a request that never left says payments are not available, not that one is being confirmed (WALLET-07 D3)', () => {
    for (const kind of ['outcome_unknown', 'not_confirmed'] as const) {
      expect(error(true, kind).toHttpException().getResponse()).toMatchObject({
        reason: { code: 'provider_unreachable', message: NOT_AVAILABLE },
      });
    }
  });

  it('a lost answer still says it is being confirmed', () => {
    for (const kind of ['outcome_unknown', 'not_confirmed'] as const) {
      expect(error(false, kind).toHttpException().getResponse()).toMatchObject({
        reason: { code: 'provider_unreachable', message: STILL_CONFIRMING },
      });
    }
  });
});
