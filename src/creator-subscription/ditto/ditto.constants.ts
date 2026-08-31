/**
 * Ditto Music distribution, bundled with Pro Max.
 *
 * The signup URL is WAWUAfrica's own partner link — the discount is attached
 * to the link, so a creator who signs up at ditto's front door pays full
 * price. That is why this is a constant and not something a client sends.
 */
export const DITTO_SIGNUP_URL = 'https://dittom.us/WAWUAfrica';

/** What a WAWUAfrica Pro Max creator saves off Ditto's own price. */
export const DITTO_DISCOUNT_PERCENT = 25;

/** The only tier the benefit is sold with. */
export const DITTO_TIER = 'pro_max' as const;
