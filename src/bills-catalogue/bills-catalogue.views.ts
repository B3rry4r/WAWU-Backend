export type MeterPlan = 'prepaid' | 'postpaid';

/** One electricity company on S3, in one plan: the code Fintava lists for it, its limits and the amounts to offer. */
export interface ElectricityBillerView {
  /** Fintava's disco code for this company and plan. The app sends it back on the meter preview and, later, on the payment. */
  code: string;
  /** "Ikeja Electric". */
  name: string;
  /** `prepaid` or `postpaid`: the plan this code is for. S3 says it under the name and S4 after it. */
  plan: MeterPlan;
  /** This company's own smallest and largest amount, in kobo, as Fintava lists them (never a fixed figure). Zero is a listed minimum. */
  minimumKobo: number;
  maximumKobo: number;
  /** The quick amounts to offer, in kobo: the configured ones that fit between the two limits. */
  presetsKobo: number[];
}

export interface ElectricityBillersView {
  /**
   * False when Fintava lists no company as available, or its bills service cannot be used (no key, a refused key, an
   * inactive merchant). S2 then draws S13. A listing that cannot be reached at all is not this: it answers 503.
   */
  available: boolean;
  billers: ElectricityBillerView[];
}

/** What Fintava says is on a meter, for S4 under the number. */
export interface MeterPreviewView {
  /** The digits as checked. */
  meterNumber: string;
  /** The code the check was made against, with its plan. */
  code: string;
  plan: MeterPlan;
  /** The name the meter is registered to; null when Fintava's answer carries none (the screen then says only that the meter was found). */
  name: string | null;
  /** Where it is registered; null when Fintava's answer carries none. */
  address: string | null;
}
