/**
 * Fintava webhook deliveries for the MONEY-07 tests, built from Fintava's
 * documented examples (mobile repo `docs/fintava/reference/webhook-events.md`),
 * field for field. No real delivery has been received yet: there is no
 * tunnel (DECISIONS R-25), so the tests sign these locally with a local
 * secret and send them to the local endpoint. Real ones are recorded into
 * `docs/fintava/sandbox/23-webhooks.md` once OPS-10 registers the
 * production URL.
 *
 * Each builder takes a run id that is appended to every reference, so a
 * test run owns its rows (and can delete them) and two runs on one
 * database never collide. Bodies are JSON text, pretty-printed as the docs
 * print them: the signature covers these exact bytes.
 */

export function accountFunded(run: string): string {
  return `{
  "event": "account_funded",
  "data": {
    "userId": "bf61c3cf-4894-4a01-91b1-e4c5e2fa2b08",
    "amount": "100.00",
    "reference": "000014231211154211281900319598-${run}",
    "senderBankSortcode": "000014",
    "sessionID": "000914231311144221237185422093",
    "channelCode": "3",
    "status": "success",
    "accountName": "John Doe",
    "beneficiaryAccountName": "Joe Services Limited",
    "beneficiaryAccountNumber": "0094886003",
    "accountNumber": "0865231291"
  }
}`;
}

/** The docs warn the name may arrive upper case; this one is, under `type`. */
export function virtualWalletPayment(run: string): string {
  return `{
  "type": "VIRTUAL_WALLET_PAYMENT",
  "data": {
    "id": "6117ef41-a058-4f16-0000-14f4561ec35b",
    "customerName": "John Doe",
    "merchantReference": "9TTEER288282882818-${run}",
    "expireTimeInMin": 30,
    "description": "Payment",
    "metadata": null,
    "amount": "650.00",
    "phone": "09070729756",
    "email": "customer@example.com",
    "bank": "Loma Bank",
    "virtualAcctName": "Google Inc Limited/Fintava",
    "virtualAcctNo": "1164658900",
    "requestTime": "2024-03-15T14:06:07.473Z",
    "status": "PAID",
    "paymentStatus": "PAID"
  }
}`;
}

export function customerBankTransfer(run: string, status = 'SUCCESS'): string {
  return `{
  "event": "customer_bank_transfer",
  "data": {
    "amount": 100,
    "vat": 0,
    "reference": "2e076e1-019a-4a3c-b1a6-65b0d98-${run}",
    "customerId": "e17402-0d82-4774-a020-716d819d0",
    "availableBalance": 109.52,
    "bookedBalance": 109.52,
    "status": "${status}",
    "total": 130.75,
    "description": "Payment",
    "destination": "81450/100004",
    "sessionID": "1106110503777587020112",
    "customerReference": "FIO241106308911000370001675-${run}",
    "senderName": "ADF Limited",
    "senderAccountNumber": "0000037726",
    "charges": 30.75
  }
}`;
}

export function walletToWallet(run: string): string {
  return `{
  "event": "wallet_to_wallet_transfer_v2",
  "data": {
    "amount": 10,
    "reference": "48VYIuIAZTSVQlZ8O900JdcUJ0imoVZ1L-${run}",
    "total": 10,
    "transaction_fee": 0,
    "target_customer_id": "dc4d9318-e145-000c-00a8-c251997345c0",
    "source_customer_id": "b2ce958b-2b3c-4004-0089-c064f346b9f7",
    "target_customer_accname": "ArewaPay/John Doe",
    "source_customer_accname": "John Services Limited",
    "target_customer_accno": "0040497763",
    "source_customer_accno": "0020886993",
    "source_customer_wallet": "0031886994",
    "target_customer_wallet": "0032497867",
    "target_availableBalance": 22,
    "target_bookedBalance": 22,
    "source_availableBalance": 187,
    "source_bookedBalance": 187,
    "description": "Fund transfer between customers",
    "customer_id": "ba67c2cl-4894-0001-91b1-e7c5e3fa2b08"
  }
}`;
}

export function debitTransferReversal(run: string): string {
  return `{
  "event": "debit_transfer_reversal",
  "data": {
    "amount": 100000,
    "charges": 15,
    "vat": 0,
    "accountName": "ABC Nigeria Ltd",
    "accountNumber": "00126",
    "customerId": "dd3d6-72d-48b9-bb45-29d78b52a",
    "customerReference": "FIO241106308911000370001675-${run}",
    "type": "CREDIT",
    "status": "success",
    "total": 100015,
    "transactionReference": "ref/0906205451400533/tyqwA0xLFhqDX9BWSgzGb0C-${run}",
    "description": "Transfer reversal",
    "destination": "5509704/090405",
    "reversalRef": "r-tyqwA0xLFh2ifNhDX9BWSgzGb0C-${run}"
  }
}`;
}

/** Card payloads are unpublished ("..." in the docs); this one has no reference. */
export function cardPayment(run: string): string {
  return `{
  "event": "card_payment",
  "data": {
    "note": "unpublished payload ${run}"
  }
}`;
}

/** The personal data in the payloads above: none of it may reach a log. */
export const PERSONAL_DATA = [
  'John Doe',
  'Joe Services Limited',
  'ADF Limited',
  'ABC Nigeria Ltd',
  'John Services Limited',
  '0094886003',
  '0865231291',
  '0000037726',
  '0040497763',
  '0020886993',
  '09070729756',
  'customer@example.com',
  '1164658900',
];
