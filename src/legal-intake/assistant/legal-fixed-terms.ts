/**
 * What S24 and S26 say beside a fixed-price service's price: how long it
 * takes and what the person needs to hand over. The words are the boards'
 * own ("5-7 working days", "ID, 2 name options, address"). The PRICE is never
 * here: it is the service's record in admin (R-14, `LegalServicePrice`).
 *
 * Default (lead, R2-LEGAL2), owner may override: a service with no entry says
 * nothing about either, and S26 draws neither row.
 */
export interface FixedPriceTerms {
  turnaround: string;
  needs: string[];
}

export const FIXED_PRICE_TERMS: Readonly<Record<string, FixedPriceTerms>> = {
  'cac-registration': {
    turnaround: '5 to 7 working days',
    needs: ['ID', '2 name options', 'address'],
  },
};
