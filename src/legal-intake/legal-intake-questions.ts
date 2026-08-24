/**
 * The legal profiling questions, and the rules that decide which of them a
 * given person actually sees.
 *
 * WHY THIS LIVES ON THE SERVER. Three surfaces need to agree about these
 * questions: the app that asks them, the brief generator that reads the
 * answers back, and the consultant's dashboard that renders them as a
 * transcript. If the app owned the labels, a consultant would eventually read
 * a brief whose question text no longer matched what the client was shown.
 * So the server owns the questions and the app renders whatever it is handed.
 *
 * WHY IT IS ADAPTIVE. Somebody chasing an unpaid invoice should not be asked
 * fifteen entertainment-licensing questions. Each question can declare
 * `showIf`, and matter-specific questions are appended for the matters that
 * have them. The intake is meant to take two to three minutes.
 *
 * WHY MOST OF IT IS TAP-TO-ANSWER. People describing a legal problem in a
 * free-text box write either three words or nine paragraphs, and neither
 * gives a lawyer what they need. Options give the brief structure; the one
 * free-text box that matters is the description, and it has suggested
 * openers under it.
 */

/** How hard we push on an answer. Nothing here is mandatory by default. */
export type QuestionLevel = 'required' | 'optional';

export type QuestionKind = 'single' | 'multi' | 'text' | 'date' | 'documents';

export interface QuestionOption {
  value: string;
  label: string;
}

export interface IntakeQuestion {
  id: string;
  step: number;
  /** The heading for the step this question belongs to. */
  stepTitle: string;
  prompt: string;
  kind: QuestionKind;
  level: QuestionLevel;
  options?: QuestionOption[];
  /** Placeholder for a text question. */
  placeholder?: string;
  /** Tappable openers under a text box, so nobody faces an empty field. */
  suggestions?: string[];
  helper?: string;
  /**
   * Only ask this when a previous answer matches. `equals` matches a single
   * answer; `includes` matches one of several.
   */
  showIf?: { questionId: string; includes: string[] };
}

/* ------------------------------------------------------------------ *
 * Step 1 — the matter. Asked before the intake starts, so it is not a
 * question in the list; it is what SELECTS the list.
 * ------------------------------------------------------------------ */

export const LEGAL_MATTERS = [
  { value: 'contract', label: 'Contract drafting or review' },
  { value: 'business_registration', label: 'Business registration' },
  { value: 'trademark', label: 'Trademark' },
  { value: 'copyright_ip', label: 'Copyright or IP' },
  { value: 'partnership', label: 'Partnership agreement' },
  { value: 'employment', label: 'Employment' },
  { value: 'debt_recovery', label: 'Debt recovery' },
  { value: 'consultation', label: 'Legal consultation' },
  { value: 'property', label: 'Property' },
  { value: 'tax', label: 'Tax' },
  { value: 'data_protection', label: 'Data protection' },
  { value: 'creator', label: 'Creator or entertainment' },
  { value: 'cross_border', label: 'Cross-border legal support' },
  { value: 'other', label: 'Something else' },
] as const;

export type LegalMatter = (typeof LEGAL_MATTERS)[number]['value'];

export const LEGAL_MATTER_VALUES = LEGAL_MATTERS.map((m) => m.value);

export function matterLabel(value: string): string {
  return LEGAL_MATTERS.find((m) => m.value === value)?.label ?? value;
}

/**
 * Which priced catalogue service a matter resolves to when the intake becomes
 * a real request.
 *
 * Deliberately a separate taxonomy. "Contract drafting or review" is one
 * thing to a client and two differently-priced services to operations, and
 * asking a worried client to tell those apart before anyone has heard their
 * problem is the mistake this whole flow exists to undo. The consultant picks
 * the exact service; this is the sensible default.
 */
export const MATTER_TO_SERVICE_CODE: Record<LegalMatter, string> = {
  contract: 'contract-review',
  business_registration: 'cac-registration',
  trademark: 'trademark-registration',
  copyright_ip: 'copyright-ip',
  partnership: 'partnership-agreement',
  employment: 'employment-agreement',
  debt_recovery: 'debt-recovery',
  consultation: 'legal-consultation',
  property: 'property-documentation',
  tax: 'tax-advisory',
  data_protection: 'data-protection-filing',
  creator: 'creative-collaboration',
  cross_border: 'cross-border',
  other: 'legal-consultation',
};

/* ------------------------------------------------------------------ *
 * Steps 2-9 — asked of everybody.
 * ------------------------------------------------------------------ */

const COMMON_QUESTIONS: IntakeQuestion[] = [
  // ---- Step 2: who you are -----------------------------------------
  {
    id: 'client_type',
    step: 2,
    stepTitle: 'Tell us about you',
    prompt: 'Who are you, for this matter?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'individual', label: 'Individual' },
      { value: 'business_owner', label: 'Business owner' },
      { value: 'company', label: 'Company' },
      { value: 'creator', label: 'Creator' },
      { value: 'artist', label: 'Artist' },
      { value: 'employer', label: 'Employer' },
      { value: 'employee', label: 'Employee' },
      { value: 'investor', label: 'Investor' },
      { value: 'professional', label: 'Professional' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'gender',
    step: 2,
    stepTitle: 'Tell us about you',
    prompt: 'Gender',
    kind: 'single',
    // Optional, and it carries into the brief only where it bears on the
    // matter — family, employment discrimination, some property questions.
    // A consultant does not need it to review a supply contract.
    level: 'optional',
    helper: 'Only used where it affects the legal position.',
    options: [
      { value: 'male', label: 'Male' },
      { value: 'female', label: 'Female' },
      { value: 'unstated', label: 'Prefer not to say' },
    ],
  },
  {
    id: 'based_in',
    step: 2,
    stepTitle: 'Tell us about you',
    prompt: 'Where are you based?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'nigeria', label: 'Nigeria' },
      { value: 'ghana', label: 'Ghana' },
      { value: 'kenya', label: 'Kenya' },
      { value: 'south_africa', label: 'South Africa' },
      { value: 'other_african', label: 'Another African country' },
      { value: 'outside_africa', label: 'Outside Africa' },
    ],
  },
  {
    id: 'jurisdiction',
    step: 2,
    stepTitle: 'Tell us about you',
    prompt: 'Where does this matter concern?',
    kind: 'single',
    level: 'required',
    helper: 'This decides which law applies, so it is worth getting right.',
    options: [
      { value: 'nigeria', label: 'Nigeria' },
      { value: 'other_african', label: 'Another African country' },
      { value: 'multiple_african', label: 'Several African countries' },
      { value: 'outside_africa', label: 'Outside Africa' },
    ],
  },

  // ---- Step 3: the issue -------------------------------------------
  {
    id: 'description',
    step: 3,
    stepTitle: 'The issue',
    prompt: 'Briefly tell us what happened, or what you need.',
    kind: 'text',
    level: 'required',
    placeholder:
      'A few lines is plenty. Your consultant reads this before you speak.',
    suggestions: [
      'I need a contract reviewed',
      'I want to register my business',
      'Someone owes me money',
      'I want to protect my brand',
      'I have a dispute',
      'I need legal advice',
      'I need legal representation',
      'I want to create an agreement',
      'I received a legal notice',
    ],
  },
  {
    id: 'stage',
    step: 3,
    stepTitle: 'The issue',
    prompt: 'What stage are you at?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'exploring', label: 'Just exploring' },
      { value: 'planning', label: 'Planning' },
      { value: 'ready', label: 'Ready to proceed' },
      { value: 'started', label: 'Already started' },
      {
        value: 'have_document',
        label: 'I already have an agreement or document',
      },
      { value: 'dispute', label: 'There is an ongoing dispute' },
      { value: 'legal_action', label: 'Legal action has already started' },
    ],
  },

  // ---- Step 4: timeline --------------------------------------------
  {
    id: 'urgency',
    step: 4,
    stepTitle: 'Timing',
    prompt: 'How soon do you need help?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'no_rush', label: 'No rush — 2 to 4 weeks' },
      { value: 'soon', label: 'Soon — 1 to 2 weeks' },
      { value: 'urgent', label: 'Urgent — 3 to 7 days' },
      { value: 'very_urgent', label: 'Very urgent — within 48 hours' },
      { value: 'immediate', label: 'Immediate — today' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    id: 'has_deadline',
    step: 4,
    stepTitle: 'Timing',
    prompt: 'Is there a specific deadline?',
    kind: 'single',
    level: 'optional',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    id: 'deadline_date',
    step: 4,
    stepTitle: 'Timing',
    prompt: 'When is the deadline?',
    kind: 'date',
    level: 'optional',
    showIf: { questionId: 'has_deadline', includes: ['yes'] },
  },

  // ---- Step 5: what you want done ----------------------------------
  {
    id: 'outcome',
    step: 5,
    stepTitle: 'What you want',
    prompt: 'What outcome are you looking for?',
    kind: 'multi',
    level: 'required',
    helper: 'Pick as many as apply.',
    options: [
      { value: 'understand_position', label: 'Understand my legal position' },
      { value: 'review_document', label: 'Review a document' },
      { value: 'draft_document', label: 'Draft a document' },
      { value: 'resolve_dispute', label: 'Resolve a dispute' },
      { value: 'recover_money', label: 'Recover money' },
      { value: 'protect_ip', label: 'Protect my business or IP' },
      { value: 'complete_registration', label: 'Complete a registration' },
      { value: 'negotiate', label: 'Negotiate with another party' },
      { value: 'prepare_action', label: 'Prepare for legal action' },
      { value: 'avoid_action', label: 'Avoid legal action' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'engagement',
    step: 5,
    stepTitle: 'What you want',
    prompt: 'How would you prefer to proceed?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'advice_first', label: 'I want advice first' },
      { value: 'handle_it', label: 'I want the lawyer to handle the matter' },
      { value: 'unsure', label: 'I am not sure yet' },
    ],
  },

  // ---- Step 6: documents -------------------------------------------
  {
    id: 'has_documents',
    step: 6,
    stepTitle: 'Documents',
    prompt: 'Do you have documents relating to this?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      { value: 'unsure', label: 'I am not sure' },
    ],
  },
  {
    id: 'document_types',
    step: 6,
    stepTitle: 'Documents',
    prompt: 'What do you have?',
    kind: 'multi',
    level: 'optional',
    showIf: { questionId: 'has_documents', includes: ['yes'] },
    options: [
      { value: 'contract', label: 'Contract or agreement' },
      { value: 'invoice', label: 'Invoice or receipt' },
      { value: 'legal_notice', label: 'Legal notice' },
      { value: 'court_document', label: 'Court document' },
      { value: 'emails', label: 'Emails' },
      { value: 'messages', label: 'WhatsApp or messages' },
      { value: 'registration', label: 'Registration documents' },
      { value: 'property', label: 'Property documents' },
      { value: 'financial', label: 'Financial records' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'documents',
    step: 6,
    stepTitle: 'Documents',
    prompt: 'Attach anything you already have',
    kind: 'documents',
    level: 'optional',
    helper: 'Only your consultant sees these. You can also send them later.',
    showIf: { questionId: 'has_documents', includes: ['yes'] },
  },

  // ---- Step 7: other parties ---------------------------------------
  {
    id: 'other_party',
    step: 7,
    stepTitle: 'Anyone else involved',
    prompt: 'Is another person or organisation involved?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    id: 'other_party_type',
    step: 7,
    stepTitle: 'Anyone else involved',
    prompt: 'Who are they?',
    kind: 'single',
    level: 'optional',
    showIf: { questionId: 'other_party', includes: ['yes'] },
    options: [
      { value: 'individual', label: 'An individual' },
      { value: 'company', label: 'A company' },
      { value: 'employer', label: 'An employer' },
      { value: 'employee', label: 'An employee' },
      { value: 'customer', label: 'A customer' },
      { value: 'supplier', label: 'A supplier' },
      { value: 'business_partner', label: 'A business partner' },
      { value: 'government', label: 'A government agency' },
      { value: 'bank', label: 'A bank or financial institution' },
      { value: 'creator', label: 'A creator or artist' },
      { value: 'brand', label: 'A brand' },
      { value: 'landlord_tenant', label: 'A landlord or tenant' },
      { value: 'other', label: 'Someone else' },
    ],
  },
  {
    id: 'other_party_relationship',
    step: 7,
    stepTitle: 'Anyone else involved',
    prompt: 'What is your relationship with them?',
    kind: 'text',
    level: 'optional',
    placeholder: 'A sentence is enough.',
    showIf: { questionId: 'other_party', includes: ['yes'] },
  },

  // ---- Step 8: money -----------------------------------------------
  {
    id: 'involves_money',
    step: 8,
    stepTitle: 'Money involved',
    prompt: 'Does this matter involve money?',
    kind: 'single',
    level: 'required',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    id: 'amount_band',
    step: 8,
    stepTitle: 'Money involved',
    prompt: 'Roughly how much?',
    kind: 'single',
    level: 'optional',
    // A band rather than a figure. It gives the consultant the scale they
    // need without making somebody state an exact sum they may not know, or
    // may not want on file before they have spoken to anybody.
    helper: 'A range is fine — your consultant only needs the scale.',
    showIf: { questionId: 'involves_money', includes: ['yes'] },
    options: [
      { value: 'under_100k', label: 'Under ₦100,000' },
      { value: '100k_500k', label: '₦100,000 – ₦500,000' },
      { value: '500k_1m', label: '₦500,000 – ₦1M' },
      { value: '1m_5m', label: '₦1M – ₦5M' },
      { value: '5m_10m', label: '₦5M – ₦10M' },
      { value: 'above_10m', label: 'Above ₦10M' },
      { value: 'unstated', label: 'Prefer not to say' },
    ],
  },

  // ---- Step 9: anything else ---------------------------------------
  {
    id: 'anything_else',
    step: 9,
    stepTitle: 'Anything else',
    prompt: 'Is there anything else your consultant should know?',
    kind: 'text',
    level: 'optional',
    placeholder: 'Anything that would help. You can leave this empty.',
  },
];

/* ------------------------------------------------------------------ *
 * Matter-specific questions, inserted at step 3.
 * ------------------------------------------------------------------ */

/**
 * The questions that only make sense for one kind of matter.
 *
 * These are the difference between an intake that feels written for you and a
 * form that asks a landlord about royalty splits. They sit at step 3, next to
 * the description, because that is where somebody is already thinking about
 * the specifics of their problem.
 */
const MATTER_QUESTIONS: Partial<Record<LegalMatter, IntakeQuestion[]>> = {
  trademark: [
    {
      id: 'tm_in_use',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Have you already started using the brand?',
      kind: 'single',
      level: 'required',
      helper: 'First use matters for what you can claim.',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'Not yet' },
      ],
    },
    {
      id: 'tm_registered_before',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Have you registered this trademark before?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
        { value: 'unsure', label: 'Not sure' },
      ],
    },
    {
      id: 'tm_scope',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Where do you want protection?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'nigeria', label: 'Nigeria' },
        { value: 'africa', label: 'Across Africa' },
        { value: 'multiple', label: 'Several countries' },
        { value: 'global', label: 'Global' },
      ],
    },
  ],
  debt_recovery: [
    {
      id: 'debt_written_agreement',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Is there a written agreement or invoice for the debt?',
      kind: 'single',
      level: 'required',
      helper: 'This largely decides how straightforward recovery is.',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No, it was verbal' },
        { value: 'partial', label: 'Partly — messages or emails only' },
      ],
    },
    {
      id: 'debt_age',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'How long has it been owed?',
      kind: 'single',
      level: 'required',
      // Limitation periods are the first thing a lawyer checks, and a client
      // never volunteers this unprompted.
      helper: 'There are time limits on recovering a debt.',
      options: [
        { value: 'under_3m', label: 'Under 3 months' },
        { value: '3_12m', label: '3 to 12 months' },
        { value: '1_3y', label: '1 to 3 years' },
        { value: 'over_3y', label: 'Over 3 years' },
        { value: 'unsure', label: 'Not sure' },
      ],
    },
    {
      id: 'debt_contacted',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Have you formally asked them to pay?',
      kind: 'single',
      level: 'optional',
      options: [
        { value: 'demand_letter', label: 'Yes, a written demand' },
        { value: 'informal', label: 'Informally only' },
        { value: 'no', label: 'Not yet' },
      ],
    },
  ],
  contract: [
    {
      id: 'contract_signed',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Has anyone signed it yet?',
      kind: 'single',
      level: 'required',
      helper: 'Advice before signing is a different job from advice after.',
      options: [
        { value: 'not_signed', label: 'Nobody has signed' },
        { value: 'other_signed', label: 'The other side has signed' },
        { value: 'both_signed', label: 'Both sides have signed' },
      ],
    },
    {
      id: 'contract_verbal_terms',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Have you already agreed anything verbally?',
      kind: 'single',
      level: 'optional',
      helper: 'A verbal agreement can still bind you.',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
        { value: 'unsure', label: 'Not sure' },
      ],
    },
  ],
  employment: [
    {
      id: 'employment_side',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Which side are you on?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'employer', label: 'I am the employer' },
        { value: 'employee', label: 'I am the employee' },
      ],
    },
    {
      id: 'employment_status',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Is the employment ongoing?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'ongoing', label: 'Yes, ongoing' },
        { value: 'ending', label: 'It is ending' },
        { value: 'ended', label: 'It has ended' },
        { value: 'not_started', label: 'It has not started yet' },
      ],
    },
  ],
  business_registration: [
    {
      id: 'reg_structure',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'What are you registering?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'business_name', label: 'A business name' },
        { value: 'limited', label: 'A limited company' },
        { value: 'ngo', label: 'An NGO or trustee body' },
        { value: 'unsure', label: 'I am not sure which I need' },
      ],
    },
    {
      id: 'reg_names_ready',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Do you have your proposed names ready?',
      kind: 'single',
      level: 'optional',
      helper: 'CAC needs alternatives in case the first is taken.',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'one_only', label: 'Only one' },
        { value: 'no', label: 'Not yet' },
      ],
    },
  ],
  property: [
    {
      id: 'property_role',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'What is your position?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'buying', label: 'Buying' },
        { value: 'selling', label: 'Selling' },
        { value: 'leasing', label: 'Leasing or renting' },
        { value: 'landlord', label: 'I am the landlord' },
        { value: 'tenant', label: 'I am the tenant' },
        { value: 'inherited', label: 'Inherited or family property' },
        { value: 'dispute', label: 'In a dispute over it' },
      ],
    },
    {
      id: 'property_title',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Do you know what title the property has?',
      kind: 'single',
      level: 'optional',
      options: [
        { value: 'c_of_o', label: 'Certificate of Occupancy' },
        { value: 'deed', label: 'Deed of assignment' },
        { value: 'governors_consent', label: "Governor's consent" },
        { value: 'family_land', label: 'Family land' },
        { value: 'none', label: 'No documents' },
        { value: 'unsure', label: 'Not sure' },
      ],
    },
  ],
  creator: [
    {
      id: 'creator_work_type',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'What kind of work is this about?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'music', label: 'Music' },
        { value: 'film_tv', label: 'Film or TV' },
        { value: 'writing', label: 'Writing or publishing' },
        { value: 'visual_art', label: 'Visual art' },
        { value: 'influencer', label: 'Influencer or brand deal' },
        { value: 'other', label: 'Something else' },
      ],
    },
    {
      id: 'creator_rights_concern',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'What worries you most?',
      kind: 'multi',
      level: 'required',
      options: [
        { value: 'ownership', label: 'Who owns the work' },
        { value: 'royalties', label: 'Royalties or payment' },
        { value: 'exclusivity', label: 'Being locked in exclusively' },
        { value: 'credit', label: 'Credit and attribution' },
        { value: 'term', label: 'How long it lasts' },
        { value: 'usage', label: 'How my work can be used' },
        { value: 'unsure', label: 'I am not sure yet' },
      ],
    },
  ],
  partnership: [
    {
      id: 'partnership_stage',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Where is the partnership?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'forming', label: 'We are forming it' },
        { value: 'running', label: 'It is running already' },
        { value: 'changing', label: 'Somebody is joining or leaving' },
        { value: 'dissolving', label: 'We are ending it' },
        { value: 'dispute', label: 'We are in dispute' },
      ],
    },
  ],
  copyright_ip: [
    {
      id: 'ip_concern',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'What do you need?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'register', label: 'To register my rights' },
        { value: 'infringement', label: 'Someone is using my work' },
        { value: 'accused', label: 'I have been accused of infringing' },
        { value: 'licence', label: 'To license my work to someone' },
        { value: 'transfer', label: 'To transfer or assign rights' },
      ],
    },
  ],
  data_protection: [
    {
      id: 'dp_trigger',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'What brings you here?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'compliance', label: 'Routine NDPR compliance' },
        { value: 'audit', label: 'An audit or filing is due' },
        { value: 'breach', label: 'There has been a data breach' },
        { value: 'complaint', label: 'A complaint has been made' },
        {
          value: 'building',
          label: 'We are building something that handles data',
        },
      ],
    },
  ],
  cross_border: [
    {
      id: 'cb_countries',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'Which countries are involved?',
      kind: 'text',
      level: 'required',
      placeholder: 'For example: Nigeria and the UK',
    },
  ],
  tax: [
    {
      id: 'tax_concern',
      step: 3,
      stepTitle: 'The issue',
      prompt: 'What is this about?',
      kind: 'single',
      level: 'required',
      options: [
        { value: 'registration', label: 'Registering for tax' },
        { value: 'filing', label: 'Filing or returns' },
        { value: 'assessment', label: 'An assessment or demand' },
        { value: 'dispute', label: 'A dispute with the authority' },
        { value: 'planning', label: 'Planning and structuring' },
      ],
    },
  ],
};

/**
 * The questions this person should be asked, in order.
 *
 * Matter-specific questions come first within step 3, ahead of the general
 * description, because answering two sharp questions about your own situation
 * makes the free-text box much easier to start.
 */
export function questionsForMatter(matter: string): IntakeQuestion[] {
  const specific = MATTER_QUESTIONS[matter as LegalMatter] ?? [];
  const all = [...COMMON_QUESTIONS, ...specific];
  return all.sort((a, b) => {
    if (a.step !== b.step) return a.step - b.step;
    // Within step 3, matter-specific questions lead.
    const aSpecific = specific.includes(a) ? 0 : 1;
    const bSpecific = specific.includes(b) ? 0 : 1;
    return aSpecific - bSpecific;
  });
}

/** Whether a question should be shown, given what has been answered so far. */
export function isQuestionVisible(
  question: IntakeQuestion,
  answers: Record<string, unknown>,
): boolean {
  if (!question.showIf) return true;
  const value = answers[question.showIf.questionId];
  if (typeof value !== 'string') return false;
  return question.showIf.includes.includes(value);
}

/** Every question id that is valid for this matter. */
export function validQuestionIds(matter: string): Set<string> {
  return new Set(questionsForMatter(matter).map((q) => q.id));
}

/** The human label for an answer value, for the brief and the transcript. */
export function answerLabel(question: IntakeQuestion, value: string): string {
  return question.options?.find((o) => o.value === value)?.label ?? value;
}
