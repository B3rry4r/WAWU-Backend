import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  feeOf,
  NUVION_FEE_CONFIG_KEYS,
  type FeeRule,
  type NuvionFeeName,
  type NuvionFees,
} from '../../money/fees/nuvion-fee-config';
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
  'ok' | 'renewed' | 'missing' | 'renewal_failed' | 'unreadable';

/**
 * The webhook subscription is renewed before it runs out (task NUV-08).
 * Ours is the one whose address ends `/api/hub/webhooks/nuvion`. When it
 * ends within `renewMs` (or already has), it is renewed for the period it
 * was given; the answer must show it running longer, or that is a failure.
 * A subscription that is missing, one that cannot be renewed and a list that
 * cannot be read are each REPORTED (the findings table and an error log),
 * never silent: webhooks are how most money is recorded promptly.
 */
export class NuvionSubscriptionCheck {
  constructor(
    private readonly provider: NuvionWalletProvider,
    private readonly findings: NuvionReconcileFindings,
    private readonly renewMs: number,
  ) {}

  async run(now = new Date()): Promise<NuvionSubscriptionOutcome> {
    const area = this.provider.reconcile;
    let subs;
    try {
      subs = await area.listWebhookSubscriptions();
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      await this.findings.report({
        kind: 'subscription_renewal_failed',
        subject: 'subscription',
        detail: `Nuvion's webhook subscriptions could not be read (${e.kind}), so none could be checked for expiry.`,
      });
      return 'unreadable';
    }
    const ours = subs.filter((s) => pathOf(s.url) === NUVION_WEBHOOK_PATH);
    if (ours.length === 0) {
      await this.findings.report({
        kind: 'subscription_missing',
        subject: 'subscription',
        detail: `Nuvion has no webhook subscription for ${NUVION_WEBHOOK_PATH}; deliveries will not arrive and the sweep alone settles movements.`,
      });
      return 'missing';
    }
    await this.findings.resolve('subscription_missing', 'subscription');
    let outcome: NuvionSubscriptionOutcome = 'ok';
    for (const sub of ours) {
      const subject = sub.id;
      if (sub.expiresAt === null) {
        // No expiry stated: nothing can run out that we can see.
        await this.findings.resolve('subscription_renewal_failed', subject);
        continue;
      }
      // A subscription given a short period is renewed at half of it, not
      // at the setting, or it would be "about to expire" for ever.
      const window =
        sub.expiresInSeconds === null
          ? this.renewMs
          : Math.min(this.renewMs, sub.expiresInSeconds * 500);
      const left = sub.expiresAt.getTime() - now.getTime();
      if (left > window) {
        await this.findings.resolve('subscription_renewal_failed', subject);
        continue;
      }
      if (sub.expiresInSeconds === null) {
        await this.findings.report({
          kind: 'subscription_renewal_failed',
          subject,
          detail:
            'The webhook subscription is about to expire and states no period to renew it for.',
        });
        outcome = 'renewal_failed';
        continue;
      }
      try {
        const renewed = await area.renewWebhookSubscription(
          sub.id,
          sub.expiresInSeconds,
        );
        if (
          renewed.expiresAt !== null &&
          renewed.expiresAt.getTime() - now.getTime() <= window
        ) {
          await this.findings.report({
            kind: 'subscription_renewal_failed',
            subject,
            detail:
              'Nuvion accepted the renewal but the webhook subscription still ends soon.',
          });
          outcome = 'renewal_failed';
          continue;
        }
        await this.findings.resolve('subscription_renewal_failed', subject);
        if (outcome === 'ok') outcome = 'renewed';
      } catch (e) {
        if (!(e instanceof WalletProviderError)) throw e;
        await this.findings.report({
          kind: 'subscription_renewal_failed',
          subject,
          detail: `The webhook subscription is about to expire and its renewal failed (${e.kind}).`,
        });
        outcome = 'renewal_failed';
      }
    }
    return outcome;
  }
}

/** The movement each fee setting stands for, as Nuvion's simulation names it. */
const FEE_KINDS: Record<
  NuvionFeeName,
  { paymentType: 'book-transfer' | 'bank-transfer'; type: 'inflow' | 'outflow' }
> = {
  bookTransfer: { paymentType: 'book-transfer', type: 'outflow' },
  bankPayout: { paymentType: 'bank-transfer', type: 'outflow' },
  inflow: { paymentType: 'bank-transfer', type: 'inflow' },
};

/** The amount a flat setting is simulated at, in kobo. */
const FLAT_PROBE_KOBO = 100_000;
const MAX_PROBES = 8;

function probesOf(rule: FeeRule): number[] {
  if (rule.kind === 'flat') return [FLAT_PROBE_KOBO];
  return rule.bands.slice(0, MAX_PROBES).map((b) => Math.max(b.fromKobo, 100));
}

export interface NuvionFeeCheckResult {
  /** Settings compared with a simulation. */
  compared: number;
  /** Settings whose figure differs from Nuvion's. */
  differences: number;
  /** Settings not compared: unset, or Nuvion could not simulate. */
  skipped: number;
}

/**
 * `POST /fee-simulations` for each kind, compared with NUV-07's setting
 * (task NUV-08). A difference is REPORTED with both figures and the amount
 * they were compared at; the setting is never changed here (it is the
 * owner's, from Nuvion's written answer). An unset setting is skipped (NUV-07
 * already answers `fees_not_set` for it); a simulation that cannot be made
 * is skipped, not a difference.
 */
export class NuvionFeeCheck {
  constructor(
    private readonly provider: NuvionWalletProvider,
    private readonly findings: NuvionReconcileFindings,
    private readonly fees: () => NuvionFees,
  ) {}

  async run(): Promise<NuvionFeeCheckResult> {
    const fees = this.fees();
    const result: NuvionFeeCheckResult = {
      compared: 0,
      differences: 0,
      skipped: 0,
    };
    for (const name of Object.keys(FEE_KINDS) as NuvionFeeName[]) {
      const rule = fees[name];
      const subject = NUVION_FEE_CONFIG_KEYS[name];
      if (rule === null) {
        result.skipped += 1;
        continue;
      }
      const differing: Array<{
        amount: number;
        setting: number;
        nuvion: number;
      }> = [];
      let failed = false;
      for (const amount of probesOf(rule)) {
        try {
          const nuvion = await this.provider.reconcile.simulateFee({
            ...FEE_KINDS[name],
            amountKobo: amount,
          });
          const setting = feeOf(rule, amount);
          if (nuvion !== setting) differing.push({ amount, setting, nuvion });
        } catch (e) {
          if (!(e instanceof WalletProviderError)) throw e;
          failed = true;
          break;
        }
      }
      if (failed) {
        result.skipped += 1;
        continue;
      }
      result.compared += 1;
      if (differing.length === 0) {
        await this.findings.resolve('fee_differs', subject);
        continue;
      }
      result.differences += 1;
      const first = differing[0];
      const more =
        differing.length > 1
          ? ` and at ${differing.length - 1} more amounts`
          : '';
      await this.findings.report({
        kind: 'fee_differs',
        subject,
        detail: `${subject} is ${first.setting} kobo but Nuvion's simulation says ${first.nuvion} kobo at ${first.amount} kobo${more}. The setting was not changed.`,
        settingKobo: first.setting,
        providerKobo: first.nuvion,
        amountKobo: first.amount,
      });
    }
    return result;
  }
}
