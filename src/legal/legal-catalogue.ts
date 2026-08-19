/**
 * WAWU Legal service catalogue.
 *
 * Two paths, and which one a service takes is a property of the service, not
 * a choice the user makes:
 *
 *  - `simple`       — form in, document out. No lawyer in the loop. The user
 *                     fills the intake, uploads what is needed, pays, and the
 *                     finished filing is emailed to them.
 *  - `consultation` — everything else. The user pays a consultation fee first,
 *                     talks to a lawyer, and only then does WAWU quote the
 *                     work. Nothing is delivered until a contract is signed.
 *
 * Prices: consultation fees are fixed and set here. Simple-service prices are
 * `null` until WAWU sets them — an unset price falls back to being quoted
 * rather than being guessed at, because inventing a fee for a CAC filing would
 * be worse than asking.
 */

export type LegalPathId = 'simple' | 'consultation';

export interface LegalService {
  code: string;
  name: string;
  category: string;
  path: LegalPathId;
  blurb: string;
  /** Naira. `null` means WAWU bills after reviewing the request. */
  priceNaira: number | null;
  /** What the intake form must collect before the request can be submitted. */
  requiresDocuments?: boolean;
}

export const CONSULTATION_FEES = {
  chat: { medium: 'chat' as const, label: 'Chat', minutes: 60, feeNaira: 25_000 },
  zoom: { medium: 'zoom' as const, label: 'Zoom call', minutes: 60, feeNaira: 45_000 },
  /**
   * Physical consultations are booked by email and the fee is negotiated per
   * matter, so there is no number to charge up front. The request is recorded
   * and WAWU makes contact rather than opening a checkout that cannot price
   * itself.
   */
  physical: {
    medium: 'physical' as const,
    label: 'In person',
    minutes: null,
    feeNaira: null,
  },
} as const;

export type ConsultationMediumId = keyof typeof CONSULTATION_FEES;

export const LEGAL_CATEGORIES = [
  'Business Services',
  'Protection Services',
  'Contracts',
  'Disputes',
  'Property',
  'Entertainment & Creative Law',
] as const;

export const LEGAL_SERVICES: LegalService[] = [
  // ---- Simple: no consultation, no lawyer interaction ----
  {
    code: 'cac-registration',
    name: 'CAC business name registration',
    category: 'Business Services',
    path: 'simple',
    blurb: 'Register your business name with the Corporate Affairs Commission.',
    priceNaira: null,
    requiresDocuments: true,
  },
  {
    code: 'tax-registration',
    name: 'Tax registration',
    category: 'Business Services',
    path: 'simple',
    blurb: 'Get your TIN and register the business for tax.',
    priceNaira: null,
    requiresDocuments: true,
  },
  {
    code: 'data-protection-filing',
    name: 'Data protection compliance filing',
    category: 'Protection Services',
    path: 'simple',
    blurb: 'File your NDPR compliance return.',
    priceNaira: null,
    requiresDocuments: true,
  },

  // ---- Consultation required ----
  {
    code: 'partnership-agreement',
    name: 'Partnership agreements',
    category: 'Business Services',
    path: 'consultation',
    blurb: 'Set out who owns what, who does what, and what happens if it ends.',
    priceNaira: null,
  },
  {
    code: 'employment-agreement',
    name: 'Employment agreements',
    category: 'Business Services',
    path: 'consultation',
    blurb: 'Contracts for the people you hire, written to hold up here.',
    priceNaira: null,
  },
  {
    code: 'tax-advisory',
    name: 'Tax and legal advisory',
    category: 'Business Services',
    path: 'consultation',
    blurb: 'Talk through your tax position before it becomes a problem.',
    priceNaira: null,
  },
  {
    code: 'trademark-registration',
    name: 'Trademark registration',
    category: 'Protection Services',
    path: 'consultation',
    blurb: 'Protect your name, logo and brand.',
    priceNaira: null,
  },
  {
    code: 'copyright-ip',
    name: 'Copyright and IP protection',
    category: 'Protection Services',
    path: 'consultation',
    blurb: 'Register and defend what you made.',
    priceNaira: null,
  },
  {
    code: 'contract-drafting',
    name: 'Contract drafting',
    category: 'Contracts',
    path: 'consultation',
    blurb: 'A contract written for your deal, not a template.',
    priceNaira: null,
  },
  {
    code: 'contract-review',
    name: 'Contract review',
    category: 'Contracts',
    path: 'consultation',
    blurb: 'Know what you are signing before you sign it.',
    priceNaira: null,
  },
  {
    code: 'debt-recovery',
    name: 'Debt recovery',
    category: 'Disputes',
    path: 'consultation',
    blurb: 'Chase money you are owed, properly.',
    priceNaira: null,
  },
  {
    code: 'legal-consultation',
    name: 'General legal consultation',
    category: 'Disputes',
    path: 'consultation',
    blurb: 'Not sure what you need? Start here.',
    priceNaira: null,
  },
  {
    code: 'property-documentation',
    name: 'Property and legal documentation',
    category: 'Property',
    path: 'consultation',
    blurb: 'Deeds, titles, leases and the paperwork behind them.',
    priceNaira: null,
  },
  {
    code: 'cross-border',
    name: 'Cross-border business legal support',
    category: 'Property',
    path: 'consultation',
    blurb: 'Trading or incorporating outside Nigeria.',
    priceNaira: null,
  },

  // ---- Entertainment & Creative Law ----
  {
    code: 'music-contracts',
    name: 'Music contracts',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Recording, producer and split agreements.',
    priceNaira: null,
  },
  {
    code: 'film-tv-production',
    name: 'Film and TV production agreements',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Crew, cast, location and production paperwork.',
    priceNaira: null,
  },
  {
    code: 'publishing-contracts',
    name: 'Publishing contracts',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Publishing and sub-publishing deals.',
    priceNaira: null,
  },
  {
    code: 'artist-management',
    name: 'Artist management agreements',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Management terms that do not sign your career away.',
    priceNaira: null,
  },
  {
    code: 'distribution-deals',
    name: 'Distribution deals',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Get your work onto platforms without losing the rights to it.',
    priceNaira: null,
  },
  {
    code: 'licensing-agreements',
    name: 'Licensing agreements',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'License your work for sync, ads and film.',
    priceNaira: null,
  },
  {
    code: 'royalty-collection',
    name: 'Royalty collection',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Register with collecting societies and get paid what you are owed.',
    priceNaira: null,
  },
  {
    code: 'talent-release',
    name: 'Talent release forms',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Clear the people who appear in your work.',
    priceNaira: null,
  },
  {
    code: 'creative-collaboration',
    name: 'Creative collaboration agreements',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Agree splits and ownership before the work exists.',
    priceNaira: null,
  },
  {
    code: 'influencer-brand-deals',
    name: 'Influencer and brand deals',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Brand partnership terms, deliverables and usage rights.',
    priceNaira: null,
  },
  {
    code: 'nft-crypto-advisory',
    name: 'NFT and crypto legal advisory',
    category: 'Entertainment & Creative Law',
    path: 'consultation',
    blurb: 'Where digital assets meet Nigerian law.',
    priceNaira: null,
  },
];

const BY_CODE = new Map(LEGAL_SERVICES.map((s) => [s.code, s]));

export function legalService(code: string): LegalService | undefined {
  return BY_CODE.get(code);
}
