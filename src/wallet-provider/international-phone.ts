/**
 * A phone in international form (`+` and the country code, 10 to 14
 * characters in all, as Nuvion takes it); null when it is not one. Spaces,
 * dashes and brackets are dropped first. The Nigerian forms are
 * `nigerian-phone.ts`'s; this is for a number from any country (R-85).
 */
export function toInternationalPhone(
  phone: string | null | undefined,
): string | null {
  if (typeof phone !== 'string') return null;
  const d = phone.replace(/[\s\-()]/g, '');
  return /^\+[1-9]\d{8,12}$/.test(d) ? d : null;
}
