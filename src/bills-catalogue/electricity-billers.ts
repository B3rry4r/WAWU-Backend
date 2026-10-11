import type { FintavaDisco } from '../fintava/fintava.interface';
import type { ElectricityBillerView, MeterPlan } from './bills-catalogue.views';

interface Known {
  /** One key for a company, whatever its plans or codes. */
  biller: string;
  name: string;
  plan: MeterPlan;
}

/**
 * Fintava's 22 disco codes (`sandbox/16-bills-discos.md`) as company and plan. A code carries no company or plan field,
 * only its text, and Ikeja has two codes for one plan, so the two things that matter are written down here. The names of
 * the five companies the canvas draws are the canvas's; the rest are Fintava's own descriptions without the plan and
 * "Distribution". A code Fintava adds later is read from its text by `readUnknown` and listed without a deploy.
 */
const KNOWN: Record<string, Known> = {
  Ikeja_Electric_Bill_Payment: {
    biller: 'ikeja',
    name: 'Ikeja Electric',
    plan: 'prepaid',
  },
  Ikeja_Token_Purchase: {
    biller: 'ikeja',
    name: 'Ikeja Electric',
    plan: 'prepaid',
  },
  Eko_Prepaid: { biller: 'eko', name: 'Eko Electricity', plan: 'prepaid' },
  Eko_Postpaid: { biller: 'eko', name: 'Eko Electricity', plan: 'postpaid' },
  AEDC: { biller: 'aedc', name: 'Abuja Electric', plan: 'prepaid' },
  AEDC_Postpaid: { biller: 'aedc', name: 'Abuja Electric', plan: 'postpaid' },
  Ibadan_Disco_Prepaid: {
    biller: 'ibadan',
    name: 'Ibadan Electric',
    plan: 'prepaid',
  },
  Ibadan_Disco_Postpaid: {
    biller: 'ibadan',
    name: 'Ibadan Electric',
    plan: 'postpaid',
  },
  PhED_Electricity: {
    biller: 'ph',
    name: 'Port Harcourt Electric',
    plan: 'prepaid',
  },
  PH_Disco: { biller: 'ph', name: 'Port Harcourt Electric', plan: 'postpaid' },
  Kano_Electricity_Disco: {
    biller: 'kano',
    name: 'Kano Electricity',
    plan: 'prepaid',
  },
  Kano_Electricity_Disco_Postpaid: {
    biller: 'kano',
    name: 'Kano Electricity',
    plan: 'postpaid',
  },
  Kaduna_Electricity_Disco: {
    biller: 'kaduna',
    name: 'Kaduna Electricity',
    plan: 'prepaid',
  },
  Kaduna_Electricity_Disco_Postpaid: {
    biller: 'kaduna',
    name: 'Kaduna Electricity',
    plan: 'postpaid',
  },
  Jos_Disco: { biller: 'jos', name: 'Jos Electricity', plan: 'prepaid' },
  Jos_Disco_Postpaid: {
    biller: 'jos',
    name: 'Jos Electricity',
    plan: 'postpaid',
  },
  BEDC: { biller: 'bedc', name: 'BEDC', plan: 'prepaid' },
  BEDC_Postpaid: { biller: 'bedc', name: 'BEDC', plan: 'postpaid' },
  Enugu_Electricity_Distribution_Prepaid: {
    biller: 'enugu',
    name: 'Enugu Electricity',
    plan: 'prepaid',
  },
  Enugu_Electricity_Distribution_Postpaid: {
    biller: 'enugu',
    name: 'Enugu Electricity',
    plan: 'postpaid',
  },
  Aba_Power_Prepaid: { biller: 'aba', name: 'Aba Power', plan: 'prepaid' },
  Aba_Power_Postpaid: { biller: 'aba', name: 'Aba Power', plan: 'postpaid' },
};

const PLAN_WORDS = /\b(pre-?paid|post-?paid)\b/gi;
const NOISE_WORDS = /\b(bill payment|token purchase|distribution|disco)\b/gi;

/** A code Fintava lists that is not in the table: company from its text, plan from the word "postpaid" (anything else is prepaid). */
function readUnknown(disco: FintavaDisco): Known {
  const text = `${disco.description} ${disco.code}`.replace(/_/g, ' ');
  const plan: MeterPlan = /post-?paid/i.test(text) ? 'postpaid' : 'prepaid';
  const name = disco.description
    .replace(/_/g, ' ')
    .replace(PLAN_WORDS, ' ')
    .replace(NOISE_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const label = name === '' ? disco.code.replace(/_/g, ' ') : name;
  return { biller: `other:${label.toLowerCase()}`, name: label, plan };
}

/**
 * The quick amounts that fit a company's own limits, smallest first. The figures are config
 * (`BILLS_AMOUNT_PRESETS_KOBO`); a company whose largest amount is below a preset never sees it.
 */
export function presetsWithin(
  presetsKobo: readonly number[],
  minimumKobo: number,
  maximumKobo: number,
): number[] {
  return presetsKobo.filter(
    (p) => p >= minimumKobo && p <= maximumKobo && p > 0,
  );
}

/**
 * Fintava's disco list as S3 shows it: one row per company and plan, an unavailable code left out, two available codes
 * for one company and plan collapsed to the first Fintava lists (Ikeja: `Ikeja_Electric_Bill_Payment`, the code Fintava's
 * own preview-meter page uses, before `Ikeja_Token_Purchase`; if only the second is available it is the one shown).
 * Ordered by name, prepaid before postpaid.
 */
export function electricityBillers(
  discos: readonly FintavaDisco[],
  presetsKobo: readonly number[],
): ElectricityBillerView[] {
  const rows = new Map<string, ElectricityBillerView>();
  for (const disco of discos) {
    if (!disco.available) continue;
    const known = KNOWN[disco.code] ?? readUnknown(disco);
    const key = `${known.biller}|${known.plan}`;
    if (rows.has(key)) continue;
    rows.set(key, {
      code: disco.code,
      name: known.name,
      plan: known.plan,
      minimumKobo: disco.minimumKobo,
      maximumKobo: disco.maximumKobo,
      presetsKobo: presetsWithin(
        presetsKobo,
        disco.minimumKobo,
        disco.maximumKobo,
      ),
    });
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en') ||
      (a.plan === b.plan ? 0 : a.plan === 'prepaid' ? -1 : 1),
  );
}
