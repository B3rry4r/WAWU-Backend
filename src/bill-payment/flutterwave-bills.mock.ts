import { Injectable, Logger } from '@nestjs/common';
import type {
  FlutterwaveBillsClient,
  BillCategory,
  Biller,
  BillItem,
  BillPaymentResult,
  ValidatedCustomer,
} from './flutterwave-bills.client';

/**
 * Local/test stand-in for the Flutterwave Bills API.
 *
 * Bills was the ONE money module with no mock adapter. Every other one
 * (subscriptions, purchases, paid DMs, service applications, the wallet)
 * picks its adapter through `shouldUseMockFlutterwave()`, so a developer with
 * no `FLUTTERWAVE_SECRET_KEY` can run the whole product. Bills instead threw
 * "Bill payments are not configured on this server" from the first call, so
 * the entire pay-a-bill flow was unreachable without production credentials,
 * and any UI change to it could only be eyeballed.
 *
 * PROVENANCE OF THE DATA BELOW - this matters, because a mock that returns
 * tidier data than production hides exactly the bugs worth finding:
 *
 *   - The AIRTIME billers and the BIL099 item list are VERBATIM from
 *     production Flutterwave (NG). That includes the part that looks like a
 *     mistake and is not: all four "packages" under MTN carry the SAME
 *     item_code, AT099, and are named after all four networks. That quirk is
 *     reproduced deliberately. It is the whole reason the pay screen picks a
 *     package by DISTINCT item_code rather than by list length.
 *   - The other categories are representative stand-ins, not captures. The
 *     shapes are real; the specific billers, bouquets and prices are made up
 *     for local use and must never be quoted as Flutterwave's catalogue.
 *
 * Every write here is a no-op that reports success, like the sibling mocks -
 * `shouldUseMockFlutterwave()` refuses to select any of them in production.
 */
@Injectable()
export class FlutterwaveBillsMock {
  private readonly logger = new Logger(FlutterwaveBillsMock.name);

  private readonly categories: BillCategory[] = [
    { id: 1, name: 'Airtime', code: 'AIRTIME', country: 'NG' },
    { id: 2, name: 'Mobile Data', code: 'MOBILEDATA', country: 'NG' },
    { id: 3, name: 'Cable TV', code: 'CABLEBILLS', country: 'NG' },
    { id: 4, name: 'Electricity', code: 'UTILITYBILLS', country: 'NG' },
    { id: 5, name: 'Internet', code: 'INTSERVICE', country: 'NG' },
  ];

  private readonly billers: Record<string, Biller[]> = {
    // Verbatim from production, including the upper-cased names.
    AIRTIME: [
      { id: 99, name: 'MTN Nigeria', biller_code: 'BIL099', country_code: 'NG' },
      { id: 100, name: 'AIRTEL NIGERIA', biller_code: 'BIL100', country_code: 'NG' },
      { id: 102, name: 'GLO NIGERIA', biller_code: 'BIL102', country_code: 'NG' },
      { id: 103, name: '9MOBILE NIGERIA', biller_code: 'BIL103', country_code: 'NG' },
    ],
    MOBILEDATA: [
      { id: 201, name: 'MTN Data', biller_code: 'BIL201', country_code: 'NG' },
      { id: 202, name: 'Airtel Data', biller_code: 'BIL202', country_code: 'NG' },
    ],
    CABLEBILLS: [
      { id: 301, name: 'DSTV', biller_code: 'BIL301', country_code: 'NG' },
      { id: 302, name: 'GOTV', biller_code: 'BIL302', country_code: 'NG' },
    ],
    UTILITYBILLS: [
      { id: 401, name: 'Ikeja Electric', biller_code: 'BIL401', country_code: 'NG' },
      { id: 402, name: 'Eko Electric', biller_code: 'BIL402', country_code: 'NG' },
    ],
    INTSERVICE: [
      { id: 501, name: 'Spectranet', biller_code: 'BIL501', country_code: 'NG' },
    ],
  };

  private readonly items: Record<string, BillItem[]> = {
    // VERBATIM. Four rows, one item_code, named after all four networks.
    BIL099: this.airtimeItems('BIL099'),
    BIL100: this.airtimeItems('BIL100'),
    BIL102: this.airtimeItems('BIL102'),
    BIL103: this.airtimeItems('BIL103'),

    // A real multi-package biller: distinct codes, distinct prices, so the
    // package step is a genuine choice and must still be shown.
    BIL301: [
      { id: 3011, biller_code: 'BIL301', name: 'DStv Padi', item_code: 'CB3011', amount: 4400, label_name: 'SmartCard Number' },
      { id: 3012, biller_code: 'BIL301', name: 'DStv Yanga', item_code: 'CB3012', amount: 6000, label_name: 'SmartCard Number' },
      { id: 3013, biller_code: 'BIL301', name: 'DStv Confam', item_code: 'CB3013', amount: 11000, label_name: 'SmartCard Number' },
    ],
    BIL302: [
      { id: 3021, biller_code: 'BIL302', name: 'GOtv Smallie', item_code: 'CB3021', amount: 1900, label_name: 'SmartCard Number' },
      { id: 3022, biller_code: 'BIL302', name: 'GOtv Jinja', item_code: 'CB3022', amount: 3900, label_name: 'SmartCard Number' },
    ],
    BIL201: [
      { id: 2011, biller_code: 'BIL201', name: '1GB - 30 days', item_code: 'MD2011', amount: 1000, label_name: 'Mobile Number' },
      { id: 2012, biller_code: 'BIL201', name: '5GB - 30 days', item_code: 'MD2012', amount: 4500, label_name: 'Mobile Number' },
    ],
    BIL202: [
      { id: 2021, biller_code: 'BIL202', name: '1.5GB - 30 days', item_code: 'MD2021', amount: 1000, label_name: 'Mobile Number' },
    ],
    // Prepaid power: one product, open amount. Same "no real choice" shape as
    // airtime, reached a different way - the step must skip here too.
    BIL401: [
      { id: 4011, biller_code: 'BIL401', name: 'Ikeja Prepaid', item_code: 'UB4011', amount: 0, label_name: 'Meter Number' },
    ],
    BIL402: [
      { id: 4021, biller_code: 'BIL402', name: 'Eko Prepaid', item_code: 'UB4021', amount: 0, label_name: 'Meter Number' },
    ],
    BIL501: [
      { id: 5011, biller_code: 'BIL501', name: 'Spectranet 20GB', item_code: 'IS5011', amount: 7000, label_name: 'Account Number' },
    ],
  };

  private airtimeItems(billerCode: string): BillItem[] {
    return ['MTN VTU', 'GLO Nigeria', '9Mobile', 'Airtel Nigeria'].map((name, i) => ({
      id: 990 + i,
      biller_code: billerCode,
      name,
      item_code: 'AT099',
      amount: 0,
      label_name: 'Mobile Number',
    }));
  }

  listCategories(_country = 'NG'): Promise<BillCategory[]> {
    return Promise.resolve(this.categories);
  }

  listBillers(category: string, _country = 'NG'): Promise<Biller[]> {
    return Promise.resolve(this.billers[category.toUpperCase()] ?? []);
  }

  listItems(billerCode: string): Promise<BillItem[]> {
    return Promise.resolve(this.items[billerCode.toUpperCase()] ?? []);
  }

  /**
   * Returns a name, the way the real one does. Nothing is validated: any
   * number "exists" here, so a local run can always get past this step.
   */
  validateCustomer(itemCode: string, customer: string): Promise<ValidatedCustomer> {
    return Promise.resolve({
      name: 'Mock Customer',
      customer,
      product_code: itemCode,
      response_code: '00',
      response_message: 'Successful',
    });
  }

  payBill(params: {
    billerCode: string;
    itemCode: string;
    customerId: string;
    amount: number;
    reference: string;
    country?: string;
  }): Promise<BillPaymentResult> {
    this.logger.log(`[mock] paid ${params.amount} to ${params.billerCode}/${params.itemCode}`);
    return Promise.resolve({
      reference: params.reference,
      tx_ref: params.reference,
      amount: params.amount,
      fee: 0,
      code: '00',
    });
  }

  billStatus(reference: string): Promise<Record<string, unknown>> {
    return Promise.resolve({ reference, status: 'successful' });
  }

  /**
   * The float check. `null` means "unknown, proceed" in the caller, which is
   * the right answer locally: there is no real balance to read.
   */
  availableNgn(): Promise<number | null> {
    return Promise.resolve(null);
  }
}

/**
 * A mock that has drifted from the thing it stands in for is worse than no
 * mock: local runs go green against an API the server does not have. This
 * fails the BUILD the moment the client gains, renames or reshapes a method
 * the mock does not follow.
 */
type BillsApi = Pick<
  FlutterwaveBillsClient,
  | 'listCategories'
  | 'listBillers'
  | 'listItems'
  | 'validateCustomer'
  | 'payBill'
  | 'billStatus'
  | 'availableNgn'
>;
const _mockImplementsClient: FlutterwaveBillsMock extends BillsApi ? true : never = true;
void _mockImplementsClient;
