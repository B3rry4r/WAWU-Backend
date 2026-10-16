import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { WalletBill } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { BillsError } from '../bills-catalogue/bills-catalogue-error';
import { BILLS_RETRY_AFTER_SECONDS } from '../bills-catalogue/bills-catalogue-error';
import { BillsCatalogueService } from '../bills-catalogue/bills-catalogue.service';
import {
  FintavaClient,
  historyPageConsistent,
} from '../fintava/fintava-client';
import { FintavaError } from '../fintava/fintava-error';
import type {
  FintavaBillReceipt,
  FintavaPage,
  FintavaTransaction,
} from '../fintava/fintava.interface';
import { toLocalNigerianPhone } from '../wallet-provider/nigerian-phone';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../wallet-provider/wallet-provider.interface';
import type { BillCategory } from '../money/dto/money-enums';
import {
  BILLS_UNAVAILABLE_MESSAGE,
  FeeQuoteService,
} from '../money/fees/fee-quote.service';
import type { FeeLines } from '../money/fees/fee-quote.service';
import type { OpenWallet } from '../money/gate/wallet-gate';
import { HoldViewService } from '../money/holds/hold-view.service';
import { WalletHoldService } from '../money/holds/wallet-hold.service';
import { LedgerService, koboNumber } from '../money/ledger/ledger.service';
import { MoneyError } from '../money/money-error';
import type { PaymentView } from '../money/money-view.type';
import type { IdempotencyScope } from '../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../money/payments/payable-registry';
import { MerchantWallet } from '../money/payments/merchant-wallet';
import { joinNotes } from '../money/payments/payment-figures';
import { WalletPaymentService } from '../money/payments/wallet-payment.service';
import { isUniqueViolationOn } from '../money/prisma-unique';
import type { CreateWalletBillDto, PayWalletBillDto } from './wallet-bill.dto';
import {
  AIRTIME_MINIMUM_KOBO,
  BILL_ALREADY_PAID_MESSAGE,
  BILL_CHANGED_MESSAGE,
  BILL_FAILED_MESSAGE,
  BILL_FAILED_RETURNED_REASON,
  BILL_FAILED_RETURNING_REASON,
  BILL_NOT_FOUND_MESSAGE,
  BILLER_TITLES,
  boughtNothing,
  type BillSpec,
  type BillStatus,
  CABLE_PROVIDERS,
  type HistoryGuard,
  HISTORY_SKEW_MS,
  NETWORKS,
  newBillReference,
  progressOf,
  purchaseInputOf,
  readHistory,
  tokenOf,
  unitsOf,
} from './wallet-bill-rules';
import type {
  BillReturnView,
  WalletBillQuoteView,
  WalletBillView,
} from './wallet-bill-view.type';

/** The pay route's key scope (idempotency.ts): `POST /bills/wallet/pay`. */
export const BILL_PAY_ROUTE = 'POST bills/wallet/pay';

/** What Fintava sees on the purchase; it names nobody. */
export const BILL_NARRATION = 'WAWU bill';

/** How far back the late-success look goes, and the words it leaves on the payment. */
const LATE_SCAN_HOURS = 48;
/** One pass reads this many failures, and walks at most this many pages of 100 records. */
const LATE_SCAN_BATCH = 50;
const LATE_SCAN_HISTORY_TAKE = 100;
const LATE_SCAN_HISTORY_PAGES = 10;
const LATE_MARKER = 'bill delivered after the bill was refunded';

/** The payment kind this feature registers. */
export const BILL_PAYMENT_KIND = 'bill' as const;

/** Fintava's own words never reach a person: this is what they read when the lists cannot be had. */
const UNUSABLE = new Set<string>([
  'not_configured',
  'auth',
  'merchant_inactive',
]);

/** The purchase's outcome is not known yet: the payment keeps delivering, and nothing is bought again. */
export class BillOutcomeOpen extends Error {
  constructor(billId: string) {
    super(`bill ${billId}: the purchase outcome is not known yet`);
    this.name = 'BillOutcomeOpen';
  }
}

function spec(row: WalletBill): BillSpec & { billChargeKobo: number } {
  return {
    category: row.category as BillCategory,
    billerCode: row.billerCode,
    planType: row.planType as 'prepaid' | 'postpaid' | null,
    productCode: row.productCode,
    accountNumber: row.accountNumber,
    amountKobo: koboNumber(row.amountKobo),
    billChargeKobo: koboNumber(row.billChargeKobo),
  };
}

/** What the person is paying for, once the provider's lists have been asked. */
interface Priced {
  title: string;
  planType: 'prepaid' | 'postpaid' | null;
  productCode: string | null;
  productLabel: string | null;
  accountNumber: string;
  accountName: string | null;
  amountKobo: number;
}

/**
 * Pay a bill from the wallet (task BILLS-04: electricity, airtime, data, cable
 * TV).
 *
 * - **Two steps, one payment.** Fintava's bill calls debit WAWU's own
 *   account, not the person's (`docs/fintava/naira-api.md`, "Bills are paid
 *   from WAWU's merchant wallet"). So a bill is a `bill` wallet payment
 *   (MONEY-17) that moves `amount + Fintava's bill charge + WAWU's bill fee`
 *   from the person's wallet into WAWU's account in one transfer, followed by
 *   the purchase at Fintava (R-19, R-31). The payment is held (MONEY-18): the
 *   biller delivering releases the hold (no payee, so nothing moves and the
 *   money stays WAWU's); the biller failing refunds it to the person, with
 *   nobody acting (S12). There is no 85/15 on a bill: the amount goes to the
 *   biller.
 * - **Priced by the server.** A bill is made first (`create`), from the
 *   biller's own lists: an electricity company's minimum and maximum, a data
 *   bundle's or a cable plan's price. A bill below the company's minimum, or
 *   a meter Fintava does not know, is refused before the quote, so before any
 *   debit. The pay sheet quotes the bill (`payment`), the same total as
 *   `GET /money/fees/quote?kind=bill` shows; the person pays that quote.
 * - **Bought once.** Fintava's bill calls take no reference of ours, so a
 *   purchase cannot be sent twice and sorted out afterwards. `purchaseSentAt`
 *   is claimed by one conditional update before the call; whoever wins it
 *   buys, anyone else only asks. A purchase whose answer was lost is looked
 *   for in Fintava's merchant history and decided only by one clear record;
 *   until then the payment keeps delivering (it throws `BillOutcomeOpen`, the
 *   payment sweep asks again, and past PAYMENT_REVIEW_AFTER_HOURS a person
 *   looks). A refusal that left no record (`recordMayExist` false) is a
 *   failure and the money goes back.
 * - **At least once, idempotent.** `onCompleted` runs from the request and from
 *   the payment sweep, on any server, and every step is a conditional update
 *   or an idempotent hold call.
 * - **Bills ride on Fintava only** (R-45): a server running Nuvion answers a
 *   bill `target_not_payable` (the fee quote refuses it).
 */
@Injectable()
export class WalletBillService implements OnModuleInit {
  private readonly logger = new Logger(WalletBillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fintava: FintavaClient,
    private readonly catalogue: BillsCatalogueService,
    private readonly fees: FeeQuoteService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly holdViews: HoldViewService,
    private readonly ledger: LedgerService,
    private readonly merchant: MerchantWallet,
    @Inject(WALLET_PROVIDER)
    private readonly provider: Pick<WalletProvider, 'name'>,
  ) {}

  /** The late-success look is running in this process. */
  private scanning = false;

  onModuleInit(): void {
    this.registry.register({
      kind: BILL_PAYMENT_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.onCompleted(payment),
    });
    this.payments.presentRoute(BILL_PAY_ROUTE, (view) => this.present(view));
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** Makes a bill from what the person chose and answers its quote (S4 to S5). */
  async create(
    wallet: OpenWallet,
    dto: CreateWalletBillDto,
  ): Promise<WalletBillQuoteView> {
    // Bills ride on Fintava only (R-45): where the running provider has none,
    // nothing asks Fintava for a list first.
    if (!this.fees.providerFees.bills) {
      throw new MoneyError('target_not_payable', BILLS_UNAVAILABLE_MESSAGE);
    }
    const priced = await this.price(wallet.wawuUserId, dto);
    const lines = this.lines(dto.category, priced.amountKobo);
    const charges = chargesOf(lines);
    let row: WalletBill | null = null;
    for (let attempt = 0; attempt < 3 && row === null; attempt += 1) {
      try {
        row = await this.prisma.walletBill.create({
          data: {
            wawuUserId: wallet.wawuUserId,
            category: dto.category,
            billerCode: dto.code,
            title: priced.title,
            planType: priced.planType,
            productCode: priced.productCode,
            productLabel: priced.productLabel,
            accountNumber: priced.accountNumber,
            accountName: priced.accountName,
            amountKobo: BigInt(priced.amountKobo),
            billChargeKobo: BigInt(charges.billChargeKobo),
            serviceFeeKobo: BigInt(charges.serviceFeeKobo),
            reference: newBillReference(),
          },
        });
      } catch (e) {
        if (!isUniqueViolationOn(e, 'reference')) throw e;
      }
    }
    if (row === null) {
      throw new Error('WalletBill: no free reference after three tries.');
    }
    return this.quoteOf(wallet, row, lines);
  }

  /** The bill's quote again (S5 reopened, or past `expiresAt`). */
  async quote(wallet: OpenWallet, id: string): Promise<WalletBillQuoteView> {
    const row = await this.owned(wallet.wawuUserId, id);
    return this.quoteOf(
      wallet,
      row,
      this.lines(row.category as BillCategory, koboNumber(row.amountKobo)),
    );
  }

  /** Pays the bill from the wallet (S5 Pay, S6 PIN). Answers and replays as the bill. */
  async pay(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: PayWalletBillDto,
  ): Promise<WalletBillView> {
    const row = await this.owned(wallet.wawuUserId, dto.billId);
    const payment = await this.payments.pay(
      wallet,
      {
        kind: BILL_PAYMENT_KIND,
        targetId: row.id,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as WalletBillView | undefined) ?? this.present(payment)
    );
  }

  /** One bill as it stands (S7, S12, and what the app polls after a pay). Only its buyer reads it. */
  async read(wawuUserId: string, id: string): Promise<WalletBillView> {
    return this.viewOf(await this.owned(wawuUserId, id));
  }

  private async owned(wawuUserId: string, id: string): Promise<WalletBill> {
    const row = await this.prisma.walletBill.findFirst({
      where: { id, wawuUserId },
    });
    if (!row) throw new MoneyError('target_not_found', BILL_NOT_FOUND_MESSAGE);
    return row;
  }

  // -------------------------------------------------------------------------
  // Choosing: what is offered, at what price
  // -------------------------------------------------------------------------

  private async price(
    wawuUserId: string,
    dto: CreateWalletBillDto,
  ): Promise<Priced> {
    const wrong = (...messages: string[]) => new BadRequestException(messages);
    switch (dto.category) {
      case 'electricity': {
        if (dto.productCode !== undefined) {
          throw wrong('productCode is not sent for electricity.');
        }
        if (dto.amountKobo === undefined) {
          throw wrong('amountKobo is required for electricity.');
        }
        const view = await this.catalogue.electricityBillers();
        if (!view.available) {
          throw new BillsError(
            'bills_unavailable',
            "Bill payments aren't switched on yet.",
          );
        }
        const biller = view.billers.find((b) => b.code === dto.code);
        if (!biller) {
          throw new BillsError(
            'biller_not_found',
            'That electricity company is not available now. Pick one from the list.',
          );
        }
        if (
          dto.amountKobo < biller.minimumKobo ||
          dto.amountKobo > biller.maximumKobo
        ) {
          throw outOfRange(biller.minimumKobo, biller.maximumKobo);
        }
        // The meter is looked up here too (the app did it on S4): a number
        // Fintava does not know is refused before anything is quoted.
        const meter = await this.catalogue.previewMeter(wawuUserId, {
          code: biller.code,
          meterNumber: dto.accountNumber,
        });
        return {
          title: biller.name,
          planType: biller.plan,
          productCode: null,
          productLabel: null,
          accountNumber: dto.accountNumber,
          accountName: meter.name,
          amountKobo: dto.amountKobo,
        };
      }
      case 'airtime': {
        if (dto.productCode !== undefined) {
          throw wrong('productCode is not sent for airtime.');
        }
        if (dto.amountKobo === undefined) {
          throw wrong('amountKobo is required for airtime.');
        }
        const network = NETWORKS.find((n) => n === dto.code);
        if (!network) throw wrong('code is not a mobile network.');
        const phone = toLocalNigerianPhone(dto.accountNumber);
        if (phone === null) {
          throw wrong('accountNumber is not a Nigerian mobile number.');
        }
        if (dto.amountKobo % 100 !== 0) {
          throw wrong('Airtime is bought in whole naira.');
        }
        if (dto.amountKobo < AIRTIME_MINIMUM_KOBO) {
          throw outOfRange(AIRTIME_MINIMUM_KOBO, null);
        }
        return {
          title: BILLER_TITLES[network],
          planType: null,
          productCode: null,
          productLabel: null,
          accountNumber: phone,
          accountName: null,
          amountKobo: dto.amountKobo,
        };
      }
      case 'data': {
        if (dto.amountKobo !== undefined) {
          throw wrong('amountKobo is not sent for data: the bundle sets it.');
        }
        if (dto.productCode === undefined) {
          throw wrong('productCode is required for data.');
        }
        const network = NETWORKS.find((n) => n === dto.code);
        if (!network) throw wrong('code is not a mobile network.');
        const phone = toLocalNigerianPhone(dto.accountNumber);
        if (phone === null) {
          throw wrong('accountNumber is not a Nigerian mobile number.');
        }
        const bundles = await this.listed(() =>
          this.fintava.listDataBundles(network),
        );
        const bundle = bundles.find((b) => b.code === dto.productCode);
        if (!bundle) throw offeredNoMore();
        return {
          title: BILLER_TITLES[network],
          planType: null,
          productCode: bundle.code,
          productLabel: bundle.title,
          accountNumber: phone,
          accountName: null,
          amountKobo: bundle.priceKobo,
        };
      }
      case 'cable': {
        if (dto.amountKobo !== undefined) {
          throw wrong('amountKobo is not sent for cable: the plan sets it.');
        }
        if (dto.productCode === undefined) {
          throw wrong('productCode is required for cable.');
        }
        const provider = CABLE_PROVIDERS.find((p) => p === dto.code);
        if (!provider) throw wrong('code is not a cable provider.');
        const plans = await this.listed(() =>
          this.fintava.listCablePlans(provider),
        );
        const plan = plans.find((p) => p.code === dto.productCode);
        if (!plan || !plan.available) throw offeredNoMore();
        return {
          title: BILLER_TITLES[provider],
          planType: null,
          productCode: plan.code,
          productLabel: plan.title,
          accountNumber: dto.accountNumber,
          accountName: null,
          amountKobo: plan.priceKobo,
        };
      }
    }
  }

  /** A list from Fintava: its failures are the catalogue's (bills off, or not reachable). */
  private async listed<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      if (e instanceof FintavaError) {
        if (UNUSABLE.has(e.kind) || e.serviceNotAvailable) {
          throw new BillsError(
            'bills_unavailable',
            "Bill payments aren't switched on yet.",
          );
        }
        throw new BillsError(
          'provider_unreachable',
          'Bill payments are not available right now. Try again in a moment.',
          { retryAfterSeconds: BILLS_RETRY_AFTER_SECONDS },
        );
      }
      throw e;
    }
  }

  /**
   * The bill's charges: Fintava's bill charge, WAWU's fee and the balance
   * transfer, from the same schedule as `GET /money/fees/quote?kind=bill`.
   * `503 fees_not_set` while the running provider's fees are not set, `409
   * target_not_payable` where the provider has no bills (Nuvion), `400
   * amount_out_of_range` past the merchant cap.
   */
  private lines(category: BillCategory, amountKobo: number): FeeLines {
    return this.fees.lines({
      kind: 'bill',
      billCategory: category,
      amountKobo,
    });
  }

  // -------------------------------------------------------------------------
  // The payable kind (MONEY-17)
  // -------------------------------------------------------------------------

  /**
   * The price of a bill for the payment service: what moves into WAWU's
   * account (the bill, Fintava's charge and WAWU's fee). Asked again inside
   * the payment's claim, so the bill is checked against the biller's lists
   * each time: a company that closed, a minimum that moved or a price that
   * changed makes the bill `target_not_payable` and nothing is taken.
   */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const row = await this.owned(lookup.payerWawuUserId, lookup.targetId);
    if (row.status !== 'draft') {
      throw new MoneyError(
        'target_not_payable',
        row.status === 'failed'
          ? BILL_FAILED_MESSAGE
          : BILL_ALREADY_PAID_MESSAGE,
      );
    }
    await this.stillOffered(row);
    const category = row.category as BillCategory;
    const amount = koboNumber(row.amountKobo);
    const charges = chargesOf(this.lines(category, amount));
    return {
      title: row.title,
      priceKobo: amount + charges.billChargeKobo + charges.serviceFeeKobo,
      payee: null,
      wawuFeeKobo: charges.serviceFeeKobo,
    };
  }

  private async stillOffered(row: WalletBill): Promise<void> {
    const gone = () =>
      new MoneyError('target_not_payable', BILL_CHANGED_MESSAGE);
    const amount = koboNumber(row.amountKobo);
    switch (row.category as BillCategory) {
      case 'electricity': {
        const view = await this.catalogue.electricityBillers();
        const biller = view.billers.find(
          (b) => b.code === row.billerCode && b.plan === row.planType,
        );
        if (
          !view.available ||
          !biller ||
          amount < biller.minimumKobo ||
          amount > biller.maximumKobo
        ) {
          throw gone();
        }
        return;
      }
      case 'airtime':
        return;
      case 'data': {
        const bundles = await this.listed(() =>
          this.fintava.listDataBundles(
            row.billerCode as (typeof NETWORKS)[number],
          ),
        );
        const bundle = bundles.find((b) => b.code === row.productCode);
        if (!bundle || bundle.priceKobo !== amount) throw gone();
        return;
      }
      case 'cable': {
        const plans = await this.listed(() =>
          this.fintava.listCablePlans(
            row.billerCode as (typeof CABLE_PROVIDERS)[number],
          ),
        );
        const plan = plans.find((p) => p.code === row.productCode);
        if (!plan || !plan.available || plan.priceKobo !== amount) throw gone();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Delivery: the purchase at Fintava, then release or refund
  // -------------------------------------------------------------------------

  /**
   * The payment is confirmed and its price is held. Buys the bill once and
   * settles the hold: released when the biller delivered, refunded when the
   * biller did not. Resolves only when the bill is settled either way; throws
   * `BillOutcomeOpen` while a purchase whose answer was lost is not decided,
   * so the payment keeps delivering and nothing is bought twice.
   */
  private async onCompleted(payment: CompletedPayment): Promise<void> {
    const now = new Date();
    await this.prisma.walletBill.updateMany({
      where: { id: payment.targetId, status: 'draft' },
      data: {
        status: 'buying',
        paymentId: payment.paymentId,
        holdId: payment.holdId,
        paidAt: now,
      },
    });
    let row = await this.prisma.walletBill.findUnique({
      where: { id: payment.targetId },
    });
    if (!row) {
      throw new Error(`bill ${payment.targetId}: no such bill to deliver`);
    }
    if (row.paymentId !== payment.paymentId) {
      // Another payment paid this bill: this one is a second payment for one
      // bill, which the payment service already flags. Nothing is bought.
      this.logger.error(
        `bill ${row.id}: payment ${payment.paymentId} completed for a bill another payment paid; it is refunded`,
      );
      await this.holds.refund({ paymentId: payment.paymentId });
      return;
    }
    if (row.holdId === null && payment.holdId !== null) {
      await this.prisma.walletBill.updateMany({
        where: { id: row.id, holdId: null },
        data: { holdId: payment.holdId },
      });
    }
    switch (row.status as BillStatus) {
      case 'delivered':
        await this.holds.release({ paymentId: payment.paymentId });
        return;
      case 'failed':
        await this.holds.refund({ paymentId: payment.paymentId });
        return;
      case 'draft':
        throw new Error(`bill ${row.id}: still a draft after its payment`);
      case 'buying':
        break;
    }
    if (row.purchaseSentAt === null) {
      // Built before it is claimed: a row that cannot be bought is a bug, and
      // it must not look like a purchase that was sent.
      const purchase = purchaseInputOf(spec(row));
      const claimed = await this.prisma.walletBill.updateMany({
        where: { id: row.id, status: 'buying', purchaseSentAt: null },
        data: { purchaseSentAt: new Date() },
      });
      if (claimed.count === 1) {
        row = await this.prisma.walletBill.findUniqueOrThrow({
          where: { id: row.id },
        });
        await this.buy(row, purchase, payment);
        return;
      }
      row = await this.prisma.walletBill.findUniqueOrThrow({
        where: { id: row.id },
      });
    }
    await this.reconcile(row, payment);
  }

  /** Hands the purchase to Fintava, once, and settles on what it answered. */
  private async buy(
    row: WalletBill,
    purchase: ReturnType<typeof purchaseInputOf>,
    payment: CompletedPayment,
  ): Promise<void> {
    let receipt: FintavaBillReceipt;
    try {
      switch (purchase.category) {
        case 'electricity':
          receipt = await this.fintava.buyElectricity(purchase.input);
          break;
        case 'airtime':
          receipt = await this.fintava.buyAirtime(purchase.input);
          break;
        case 'data':
          receipt = await this.fintava.buyDataBundle(purchase.input);
          break;
        case 'cable':
          receipt = await this.fintava.buyCable(purchase.input);
          break;
      }
    } catch (e) {
      if (e instanceof FintavaError && boughtNothing(e)) {
        // Fintava refused it and no record exists (a refusal, "Unable to find
        // customers", a service that is not available, no key): the biller
        // did not deliver and nothing was debited.
        await this.fail(row, payment, e.kind);
        return;
      }
      // An answer that is lost, a 5xx, a 2xx without a purchase in it, or
      // anything that is not Fintava's own refusal: a record may exist.
      this.logger.warn(
        `bill ${row.id}: the ${row.category} purchase is not decided (${e instanceof FintavaError ? e.kind : e instanceof Error ? e.name : 'error'}); it is asked about and not sent again`,
      );
      throw new BillOutcomeOpen(row.id);
    }
    await this.deliver(row, payment, receipt);
  }

  /** The biller delivered: record it, then release the hold (no payee, so nothing moves). */
  private async deliver(
    row: WalletBill,
    payment: CompletedPayment,
    receipt: Pick<
      FintavaBillReceipt,
      'transactionId' | 'fintavaReference' | 'meterToken' | 'details'
    >,
    source: 'purchase' | 'history' = 'purchase',
  ): Promise<void> {
    let token = tokenOf({ ...receipt, amountKobo: null });
    if (
      token === null &&
      row.category === 'electricity' &&
      row.planType === 'prepaid' &&
      receipt.transactionId !== null
    ) {
      token = await this.tokenFromRecord(receipt.transactionId);
    }
    const data = {
      status: 'delivered',
      deliveredAt: new Date(),
      fintavaTransactionId: receipt.transactionId,
      fintavaReference: receipt.fintavaReference,
      token,
      units: unitsOf(receipt.details),
    };
    let settled: { count: number };
    try {
      settled = await this.prisma.walletBill.updateMany({
        where: { id: row.id, status: 'buying' },
        data,
      });
    } catch (e) {
      if (
        !isUniqueViolationOn(e, 'fintavaTransactionId') &&
        !isUniqueViolationOn(e, 'fintavaReference')
      ) {
        throw e;
      }
      if (source === 'history') {
        // Another bill took this record first: it settles one bill at most.
        this.logger.warn(
          `bill ${row.id}: the record found for it is another bill's; it is not decided`,
        );
        throw new BillOutcomeOpen(row.id);
      }
      // The answer to the purchase just made names a record another bill
      // holds. The purchase happened: deliver it, leave the ids unsaved.
      this.logger.error(
        `bill ${row.id}: Fintava answered with a record another bill holds; delivered without saving its ids`,
      );
      settled = await this.prisma.walletBill.updateMany({
        where: { id: row.id, status: 'buying' },
        data: { ...data, fintavaTransactionId: null, fintavaReference: null },
      });
    }
    if (settled.count === 0) {
      const now = await this.prisma.walletBill.findUnique({
        where: { id: row.id },
      });
      if (now?.status === 'failed') {
        await this.lateSuccess(now, receipt);
        return;
      }
    }
    await this.recordPurchase(row, receipt);
    await this.holds.release({ paymentId: payment.paymentId });
  }

  /**
   * The biller delivered a bill that was already failed and refunded to the
   * payer: WAWU paid the biller and got nothing back. Nothing is taken from
   * the person again. The payment carries the note for review (its
   * `discrepancy`, as every other money stop does), the purchase is in the
   * ledger, and it is logged once (the note is written once).
   */
  private async lateSuccess(
    row: WalletBill,
    receipt: Pick<FintavaBillReceipt, 'transactionId' | 'fintavaReference'>,
  ): Promise<void> {
    if (row.paymentId === null) return;
    const amount = koboNumber(row.amountKobo) + koboNumber(row.billChargeKobo);
    const note = `bill delivered after the bill was refunded to the payer; WAWU paid the biller ${amount} kobo and the payer was refunded (review)`;
    const payment = await this.prisma.walletPayment.findUnique({
      where: { id: row.paymentId },
      select: { discrepancy: true },
    });
    const joined = joinNotes(payment?.discrepancy, note);
    if (joined !== null && joined !== payment?.discrepancy) {
      const { count } = await this.prisma.walletPayment.updateMany({
        where: { id: row.paymentId, discrepancy: payment?.discrepancy ?? null },
        data: { discrepancy: joined },
      });
      if (count > 0) {
        this.logger.error(
          `bill ${row.id}: the biller delivered after the bill was refunded; recorded on payment ${row.paymentId} for review`,
        );
      }
    }
    await this.recordPurchase(row, receipt);
    // Keep the record on the bill, so no other bill can take it.
    try {
      await this.prisma.walletBill.updateMany({
        where: { id: row.id, fintavaTransactionId: null },
        data: {
          fintavaTransactionId: receipt.transactionId,
          fintavaReference: receipt.fintavaReference,
        },
      });
    } catch {
      // Held by another bill already: the note above stands.
    }
  }

  /**
   * Every half hour: a bill that failed and was refunded, whose purchase may
   * still have been made (a refusal that left no record is a guess, G-647),
   * is looked for in Fintava's merchant history. A record that shows up is a
   * loss to WAWU and goes to review (`lateSuccess`). It only reads: it never
   * buys again and never moves money.
   *
   * - Only bills that failed in the last two days, NEWEST first, at most
   *   LATE_SCAN_BATCH a pass; a bill already noted is not read again.
   * - Only bills whose payment belongs to the provider this server runs
   *   (R-39): after a switch to Nuvion a Fintava bill left in the database
   *   is never asked about at Fintava and gets no ledger row of the wrong
   *   provider.
   * - The merchant history is read back, page by page and by date, to the
   *   oldest failure being looked at (capped at LATE_SCAN_HISTORY_PAGES).
   * - One pass at a time: a flag for this process, and a conditional claim
   *   on the failures read, so two servers that wake together do not both
   *   look. Nothing is held across the call to Fintava.
   */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'bill-late-success' })
  async scanLateSuccesses(now: Date = new Date()): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const todo = await this.unnotedFailures(now);
      if (todo.length === 0) return;
      if (!(await this.claimLatePass(todo))) return;
      const history = await this.readLateHistory(todo);
      if (history === null) return;
      for (const bill of todo) {
        const sentAt = bill.purchaseSentAt!;
        // A history read cut short does not reach back to this bill's record.
        if (
          history.reachedBack !== null &&
          sentAt.getTime() - HISTORY_SKEW_MS < history.reachedBack
        ) {
          continue;
        }
        const guard = await this.guardFor(bill, sentAt, history.rows);
        const reading = readHistory(spec(bill), sentAt, history.rows, {
          ...guard,
          notAfter: new Date(
            (bill.failedAt ?? now).getTime() + HISTORY_SKEW_MS,
          ),
        });
        if (reading.state === 'delivered') {
          await this.lateSuccess(bill, {
            transactionId: reading.row.id,
            fintavaReference: reading.row.fintavaReference,
          });
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Failed, refunded, not yet noted, this server's provider, newest failure first. */
  private async unnotedFailures(now: Date): Promise<WalletBill[]> {
    const since = new Date(now.getTime() - LATE_SCAN_HOURS * 3_600_000);
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT b."id" AS "id"
        FROM "WalletBill" b
        JOIN "WalletPayment" p ON p."id" = b."paymentId"
       WHERE b."status" = 'failed'
         AND b."purchaseSentAt" IS NOT NULL
         AND b."failedAt" > ${since}
         AND p."provider" = ${this.provider.name}
         AND (p."discrepancy" IS NULL
              OR position(${LATE_MARKER}::text in p."discrepancy") = 0)
       ORDER BY b."failedAt" DESC, b."id" DESC
       LIMIT ${LATE_SCAN_BATCH}`;
    if (ids.length === 0) return [];
    const rows = await this.prisma.walletBill.findMany({
      where: { id: { in: ids.map((i) => i.id) } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((i) => {
      const bill = byId.get(i.id);
      return bill ? [bill] : [];
    });
  }

  /**
   * The pass belongs to whoever moves the newest failure's `checks` (how
   * many times Fintava has been asked about a purchase) from the value it
   * read: a server that read the same state loses the update and skips. A
   * short conditional write; no lock is held while Fintava is asked.
   */
  private async claimLatePass(todo: readonly WalletBill[]): Promise<boolean> {
    const lead = todo[0];
    const { count } = await this.prisma.walletBill.updateMany({
      where: { id: lead.id, status: 'failed', checks: lead.checks },
      data: { checks: { increment: 1 } },
    });
    if (count === 0) return false;
    if (todo.length > 1) {
      await this.prisma.walletBill.updateMany({
        where: { id: { in: todo.slice(1).map((b) => b.id) } },
        data: { checks: { increment: 1 } },
      });
    }
    return true;
  }

  /**
   * Fintava's merchant history, newest first, back to the oldest failure in
   * `todo` (a day earlier, as `reconcile` reads), a page at a time. `reachedBack`
   * is null when the walk covers every failure; otherwise the time of the
   * oldest record read, so bills older than it are left for a later pass.
   * Null: nothing could be read.
   */
  private async readLateHistory(todo: readonly WalletBill[]): Promise<{
    rows: FintavaTransaction[];
    reachedBack: number | null;
  } | null> {
    const oldestSent = todo.reduce(
      (t, b) => Math.min(t, b.purchaseSentAt!.getTime()),
      Number.POSITIVE_INFINITY,
    );
    const startDate = new Date(oldestSent - 24 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    const wanted = oldestSent - HISTORY_SKEW_MS;
    const rows: FintavaTransaction[] = [];
    const seen = new Set<string>();
    let first: FintavaPage<FintavaTransaction> | null = null;
    let page = 1;
    try {
      for (; page <= LATE_SCAN_HISTORY_PAGES; page += 1) {
        const got = await this.fintava.getMerchantHistory({
          startDate,
          order: 'DESC',
          page,
          take: LATE_SCAN_HISTORY_TAKE,
        });
        if (!historyPageConsistent(got, page, first)) break;
        first ??= got;
        for (const r of got.items) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            rows.push(r);
          }
        }
        const last = got.items[got.items.length - 1];
        if (
          !got.hasNextPage ||
          (last !== undefined && Date.parse(last.createdAt) < wanted)
        ) {
          return { rows, reachedBack: null };
        }
      }
    } catch (e) {
      this.logger.warn(
        `bills: Fintava's history could not be read for the late-success look (${e instanceof FintavaError ? e.kind : 'error'})`,
      );
    }
    if (rows.length === 0) return null;
    this.logger.warn(
      `bills: the late-success look read ${rows.length} records and stopped before the oldest failure; the older ones wait for a later pass`,
    );
    return {
      rows,
      reachedBack: Math.min(...rows.map((r) => Date.parse(r.createdAt))),
    };
  }

  /**
   * The purchase is money leaving WAWU's own account (the bill's amount and
   * Fintava's bill charge), so the ledger carries it for MONEY-16 to put
   * beside Fintava's balance and history. Recorded under a reference of ours
   * derived from the bill (Fintava takes none), so a repeat writes nothing
   * twice; a ledger that cannot be written is logged and never undoes a
   * delivery.
   */
  private async recordPurchase(
    row: WalletBill,
    receipt: Pick<FintavaBillReceipt, 'transactionId' | 'fintavaReference'>,
  ): Promise<void> {
    try {
      const amountKobo = koboNumber(row.amountKobo);
      const feeKobo = koboNumber(row.billChargeKobo);
      await this.ledger.record(
        {
          wallet: {
            kind: 'merchant',
            accountNumber: await this.merchant.account(),
          },
          direction: 'out',
          status: 'completed',
          category: 'bill',
          amountKobo,
          feeKobo,
          totalKobo: amountKobo + feeKobo,
          providerFeeKobo: feeKobo,
          wawuFeeKobo: 0,
          counterparty: { kind: 'biller', name: row.title },
          link: { kind: BILL_PAYMENT_KIND, targetId: row.id, title: row.title },
          narration: BILL_NARRATION,
          references: {
            customerReference: `wawu-bill-${row.id}`,
            fintavaReference: receipt.fintavaReference,
            fintavaTransactionId: receipt.transactionId,
          },
          paymentId: row.paymentId,
          source: 'send',
        },
        undefined,
        { quiet: true },
      );
    } catch (e) {
      this.logger.error(
        `bill ${row.id}: the ledger could not record the purchase (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** The token is on the transaction record too (`metertoken`): asked once, best effort. */
  private async tokenFromRecord(transactionId: string): Promise<string | null> {
    try {
      const found = await this.fintava.getTransactionById(transactionId);
      return found.state === 'found' ? found.transaction.meterToken : null;
    } catch {
      return null;
    }
  }

  /** The biller did not deliver: record it, then refund the hold to the payer. */
  private async fail(
    row: WalletBill,
    payment: CompletedPayment,
    why: string,
  ): Promise<void> {
    await this.prisma.walletBill.updateMany({
      where: { id: row.id, status: 'buying' },
      data: {
        status: 'failed',
        failedAt: new Date(),
        failureReason: BILL_FAILED_RETURNING_REASON,
      },
    });
    this.logger.warn(
      `bill ${row.id}: the ${row.category} purchase failed (${why}); the payment is refunded`,
    );
    await this.holds.refund({ paymentId: payment.paymentId });
  }

  /**
   * A purchase was handed over and no answer is on record: look for it in
   * Fintava's merchant history. One clear record decides; anything else is
   * not proof and the delivery tries again later.
   */
  private async reconcile(
    row: WalletBill,
    payment: CompletedPayment,
  ): Promise<void> {
    const sentAt = row.purchaseSentAt;
    if (sentAt === null) throw new BillOutcomeOpen(row.id);
    await this.prisma.walletBill.updateMany({
      where: { id: row.id },
      data: { checks: { increment: 1 } },
    });
    let reading: ReturnType<typeof readHistory> = { state: 'unknown' };
    try {
      const day = new Date(sentAt.getTime() - 24 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      const page = await this.fintava.getMerchantHistory({
        startDate: day,
        order: 'DESC',
        take: 100,
      });
      reading = readHistory(
        spec(row),
        sentAt,
        page.items,
        await this.guardFor(row, sentAt, page.items),
      );
    } catch (e) {
      this.logger.warn(
        `bill ${row.id}: Fintava's history could not be read (${e instanceof FintavaError ? e.kind : 'error'})`,
      );
    }
    if (reading.state === 'delivered') {
      await this.deliver(
        row,
        payment,
        {
          transactionId: reading.row.id,
          fintavaReference: reading.row.fintavaReference,
          meterToken: reading.row.meterToken,
          details: {},
        },
        'history',
      );
      return;
    }
    if (reading.state === 'failed') {
      await this.fail(row, payment, 'history');
      return;
    }
    throw new BillOutcomeOpen(row.id);
  }

  /**
   * What already belongs to other bills, so one history record settles at
   * most one bill: records stored on another bill, and nothing made before
   * the previous bill for the same meter or number and amount was delivered
   * (plus the clock-difference allowance).
   */
  private async guardFor(
    row: WalletBill,
    sentAt: Date,
    rows: readonly FintavaTransaction[],
  ): Promise<HistoryGuard> {
    const ids = rows.map((r) => r.id);
    const refs = rows.flatMap((r) =>
      r.fintavaReference === null ? [] : [r.fintavaReference],
    );
    const [taken, previous] = await Promise.all([
      this.prisma.walletBill.findMany({
        where: {
          id: { not: row.id },
          OR: [
            { fintavaTransactionId: { in: ids } },
            { fintavaReference: { in: refs } },
          ],
        },
        select: { fintavaTransactionId: true, fintavaReference: true },
      }),
      this.prisma.walletBill.findMany({
        where: {
          id: { not: row.id },
          status: 'delivered',
          category: row.category,
          accountNumber: row.accountNumber,
          amountKobo: row.amountKobo,
          deliveredAt: { not: null, lte: sentAt },
        },
        orderBy: { deliveredAt: 'desc' },
        take: 5,
        select: {
          deliveredAt: true,
          fintavaTransactionId: true,
          fintavaReference: true,
        },
      }),
    ]);
    return {
      // The earlier bill's record may carry Fintava's clock, a little ahead
      // of ours, and when that bill's answer carried no record id nothing
      // else tells its record from this bill's: nothing before its delivery
      // PLUS the skew allowance is this bill's. A real record that close is
      // left for a person (the bill stays processing), the safe side. A bill
      // whose record id or reference is stored is excluded by it, exactly.
      notBefore: previous.reduce<Date | null>((latest, b) => {
        if (b.deliveredAt === null) return latest;
        const from = new Date(
          b.deliveredAt.getTime() +
            (b.fintavaTransactionId === null && b.fintavaReference === null
              ? HISTORY_SKEW_MS
              : 0),
        );
        return latest === null || from > latest ? from : latest;
      }, null),
      takenIds: new Set(
        taken.flatMap((t) =>
          t.fintavaTransactionId === null ? [] : [t.fintavaTransactionId],
        ),
      ),
      takenReferences: new Set(
        taken.flatMap((t) =>
          t.fintavaReference === null ? [] : [t.fintavaReference],
        ),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private async quoteOf(
    wallet: OpenWallet,
    row: WalletBill,
    lines: FeeLines,
  ): Promise<WalletBillQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: BILL_PAYMENT_KIND,
      targetId: row.id,
    });
    return {
      bill: await this.viewOf(row),
      parts: lines.parts,
      payment,
    };
  }

  private async present(payment: PaymentView): Promise<WalletBillView> {
    const row = await this.prisma.walletBill.findUnique({
      where: { id: payment.targetId },
    });
    if (!row) throw new MoneyError('not_found', BILL_NOT_FOUND_MESSAGE);
    return this.viewOf(row);
  }

  async viewOf(row: WalletBill): Promise<WalletBillView> {
    const paid = row.paymentId
      ? await this.prisma.walletPayment.findUnique({
          where: { id: row.paymentId },
          select: { providerFeeKobo: true, totalKobo: true },
        })
      : null;
    let returned: BillReturnView | null = null;
    if (row.status === 'failed' && row.paymentId) {
      const hold = await this.holdViews.forPayment(row.paymentId);
      if (hold) {
        returned = {
          holdStatus: hold.status,
          returned: hold.status === 'refunded',
          returnedKobo: hold.status === 'refunded' ? hold.refundedKobo : null,
        };
      }
    }
    return {
      id: row.id,
      category: row.category as BillCategory,
      billerCode: row.billerCode,
      title: row.title,
      planType: row.planType as 'prepaid' | 'postpaid' | null,
      productCode: row.productCode,
      productLabel: row.productLabel,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      amountKobo: koboNumber(row.amountKobo),
      billChargeKobo: koboNumber(row.billChargeKobo),
      serviceFeeKobo: koboNumber(row.serviceFeeKobo),
      reference: row.reference,
      status: progressOf(row.status as BillStatus),
      paymentId: row.paymentId,
      transferFeeKobo: paid ? koboNumber(paid.providerFeeKobo) : null,
      totalKobo: paid ? koboNumber(paid.totalKobo) : null,
      token: row.token,
      units: row.units,
      // The refund is a move of its own: until it has completed the money is
      // on its way back, not returned.
      failureReason:
        row.status === 'failed'
          ? returned?.returned
            ? BILL_FAILED_RETURNED_REASON
            : BILL_FAILED_RETURNING_REASON
          : row.failureReason,
      returned,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
    };
  }
}

/** The bill charge and WAWU's fee out of a bill's fee lines. */
function chargesOf(lines: FeeLines): {
  billChargeKobo: number;
  serviceFeeKobo: number;
} {
  const of = (code: string) =>
    lines.parts
      .filter((p) => p.code === code)
      .reduce((n, p) => n + p.amountKobo, 0);
  return { billChargeKobo: of('bill_charge'), serviceFeeKobo: of('wawu_fee') };
}

function outOfRange(
  minimumKobo: number,
  maximumKobo: number | null,
): MoneyError {
  return new MoneyError(
    'amount_out_of_range',
    maximumKobo === null
      ? 'This is below the smallest amount this bill takes.'
      : 'This is outside what this company takes for one bill.',
    maximumKobo === null ? { minimumKobo } : { minimumKobo, maximumKobo },
  );
}

function offeredNoMore(): MoneyError {
  return new MoneyError(
    'target_not_found',
    'That is not offered now. Pick one from the list.',
  );
}
