import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionReconcileFindings } from './reconcile-findings';

/** Our webhook's path on this server: how a subscription is known as ours. */
export const NUVION_WEBHOOK_PATH = '/api/hub/webhooks/nuvion';

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export type NuvionSubscriptionOutcome =
  'ok' | 'missing' | 'inactive' | 'unreadable';

/**
 * The webhook subscription is looked at, not renewed (task NUV-08, round 2).
 * Nuvion's docs give a webhook an `expires_in` at creation, make it `inactive`
 * when that runs out and stop its deliveries (api-reference__webhooks.md:27
 * to :28), but show no expiry date and no call that extends one: the update
 * call takes only `url`, `rotate_secret` and `entity_id` (:725 to :740). So
 * the check reads `status` and REPORTS a subscription that is missing, one
 * that is not active and a list that cannot be read, in the findings table
 * and an error log, never silent: webhooks are how most money is recorded
 * promptly, and the sweep alone settles movements without one. Ours is the
 * subscription whose address ends `/api/hub/webhooks/nuvion`.
 */
export class NuvionSubscriptionCheck {
  constructor(
    private readonly provider: NuvionWalletProvider,
    private readonly findings: NuvionReconcileFindings,
  ) {}

  async run(): Promise<NuvionSubscriptionOutcome> {
    let subs;
    try {
      subs = await this.provider.reconcile.listWebhookSubscriptions();
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      await this.findings.report({
        kind: 'subscription_unreadable',
        subject: 'subscription',
        detail: `Nuvion's webhook subscriptions could not be read (${e.kind}), so none could be checked.`,
      });
      return 'unreadable';
    }
    await this.findings.resolve('subscription_unreadable', 'subscription');
    const ours = subs.filter((s) => pathOf(s.url) === NUVION_WEBHOOK_PATH);
    if (ours.length === 0) {
      await this.findings.report({
        kind: 'subscription_missing',
        subject: 'subscription',
        detail: `Nuvion has no webhook subscription for ${NUVION_WEBHOOK_PATH}; deliveries will not arrive and the sweep alone settles movements.`,
      });
      await this.findings.resolve('subscription_inactive', 'subscription');
      return 'missing';
    }
    await this.findings.resolve('subscription_missing', 'subscription');
    if (!ours.some((s) => s.active)) {
      await this.findings.report({
        kind: 'subscription_inactive',
        subject: 'subscription',
        detail: `Every Nuvion webhook subscription for ${NUVION_WEBHOOK_PATH} is not active, so deliveries have stopped. Nuvion gives a subscription a lifetime and no way to extend it: a new one is needed. Until then the sweep alone settles movements.`,
      });
      return 'inactive';
    }
    await this.findings.resolve('subscription_inactive', 'subscription');
    return 'ok';
  }
}

export interface NuvionFeeCheckResult {
  /** True when Nuvion's fees could be compared with the settings: false while its docs give no way to read them. */
  available: boolean;
  /** True when this run opened the finding that says so. */
  reported: boolean;
}

/** What the fee check's one finding is about. */
export const NUVION_FEE_CHECK_SUBJECT = 'fee-check';

/**
 * The fee comparison (task NUV-08, round 2): NOT AVAILABLE. Nuvion's public
 * docs describe no fee simulation (no page names `/fee-simulations` or any
 * call that quotes a fee ahead of a movement), so there is nothing documented
 * to compare NUV-07's fee settings with, and an undocumented route is never
 * called. The check says so once, as an open finding "fee check not
 * available", instead of skipping without a word; a run that finds the
 * finding already open does nothing. The settings are never changed here.
 * When Nuvion documents a way to read its fees, this file is where the
 * comparison goes.
 */
export class NuvionFeeCheck {
  constructor(private readonly findings: NuvionReconcileFindings) {}

  async run(): Promise<NuvionFeeCheckResult> {
    if (
      await this.findings.isOpen(
        'fee_check_unavailable',
        NUVION_FEE_CHECK_SUBJECT,
      )
    ) {
      return { available: false, reported: false };
    }
    await this.findings.report({
      kind: 'fee_check_unavailable',
      subject: NUVION_FEE_CHECK_SUBJECT,
      detail:
        "Fee check not available: Nuvion's public docs describe no fee simulation, so WAWU's Nuvion fee settings cannot be compared with Nuvion's own figures. Ask Nuvion for a documented way to read its fees.",
    });
    return { available: false, reported: true };
  }
}
