import { isRegulatedCategory } from './professional-categories';

/**
 * The fields the mobile app's professional directory draws (P1 to P10, and
 * the card in the feed, H10), mapped onto the professional categories.
 *
 * The canvas names a field the way a person looking for help says it
 * ("Accounting & Tax"); the backend files every listing under a category
 * (`finance`). Categories stay what they are, because the web and the admin
 * dashboard file and filter by them today. A field is a label and a set of
 * categories over the top:
 *
 * - filtering by a field returns every approved, listed professional whose
 *   category is in `categories`;
 * - applying in a field files the application under `applyCategory`, so a
 *   person picks a field on P5 and the existing application route still
 *   receives a category it knows;
 * - a listing whose category no field covers has `field: null` and appears
 *   only under "All".
 *
 * The list and its order are the canvas's: the chips on P1 and P4 and the
 * rows on P8 (PROS-02; DECISIONS has no ruling on it, so this is the agent's
 * default and the owner may change it). `regulated` is the category's own
 * rule (professional-categories.ts), never a second list.
 */
export interface ProfessionalFieldDefinition {
  id: string;
  label: string;
  categories: readonly string[];
  applyCategory: string;
}

export const PROFESSIONAL_FIELDS: readonly ProfessionalFieldDefinition[] = [
  {
    id: 'accounting_tax',
    label: 'Accounting & Tax',
    categories: ['finance'],
    applyCategory: 'finance',
  },
  {
    id: 'legal_compliance',
    label: 'Legal & Compliance',
    categories: ['legal_services'],
    applyCategory: 'legal_services',
  },
  {
    id: 'design_creative',
    label: 'Design & Creative',
    categories: ['entertainment_creative'],
    applyCategory: 'entertainment_creative',
  },
  {
    id: 'technology_it',
    label: 'Technology & IT',
    categories: ['technology'],
    applyCategory: 'technology',
  },
  {
    id: 'engineering',
    label: 'Engineering',
    categories: ['engineering'],
    applyCategory: 'engineering',
  },
  {
    id: 'healthcare',
    label: 'Healthcare',
    categories: ['healthcare'],
    applyCategory: 'healthcare',
  },
  {
    // A small business advisor (P8) files under professional services; a
    // listing already filed under business and entrepreneurship is the same
    // kind of help, so the field shows both.
    id: 'business_consulting',
    label: 'Business & Consulting',
    categories: ['professional_services', 'business_entrepreneurship'],
    applyCategory: 'professional_services',
  },
];

export const PROFESSIONAL_FIELD_IDS = PROFESSIONAL_FIELDS.map((f) => f.id);

/** One field as the app reads it: GET /professionals/fields. */
export interface ProfessionalFieldView {
  id: string;
  label: string;
  /** Every category a listing can be filed under and appear in this field. */
  categories: string[];
  /** The category an application made in this field is filed under. */
  applyCategory: string;
  /**
   * Whether applying here needs a practising licence, a licence number and
   * the body that issued it (P6). The rule of `applyCategory`.
   */
  regulated: boolean;
}

/** The field a listing shows, on a card or a profile. */
export interface ProfessionalFieldRef {
  id: string;
  label: string;
}

export function fieldViews(): ProfessionalFieldView[] {
  return PROFESSIONAL_FIELDS.map((f) => ({
    id: f.id,
    label: f.label,
    categories: [...f.categories],
    applyCategory: f.applyCategory,
    regulated: isRegulatedCategory(f.applyCategory),
  }));
}

export function findField(id: string): ProfessionalFieldDefinition | undefined {
  return PROFESSIONAL_FIELDS.find((f) => f.id === id);
}

/** The first field that covers this category, or null when none does. */
export function fieldForCategory(
  category: string,
): ProfessionalFieldRef | null {
  const f = PROFESSIONAL_FIELDS.find((d) => d.categories.includes(category));
  return f ? { id: f.id, label: f.label } : null;
}
