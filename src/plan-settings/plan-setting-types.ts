import type { PlansConfig } from '../plans/plans-config';

/**
 * What a setting can hold. Every kind is plain JSON so a row can store it.
 * A money figure is whole kobo, never a decimal (R-21).
 */
export interface MultiplierLevel {
  /** Verified referrals needed to reach the level. */
  min: number;
  /** The multiplier on the base points: 1, 1.25, 1.5, 2, 3. */
  x: number;
}

export interface MilestoneStep {
  /** Verified referrals needed. */
  count: number;
  /** Points paid once at that count. */
  points: number;
}

export type SettingValue =
  number | string | null | string[] | MultiplierLevel[] | MilestoneStep[];

/** What the dashboard shows beside a value, so it can pick an input. */
export type SettingUnit =
  | 'kobo'
  | 'count'
  | 'points'
  | 'percent'
  | 'days'
  | 'months'
  | 'hours'
  | 'time'
  | 'date'
  | 'lines'
  | 'levels'
  | 'milestones';

/** A config with its readonly marks taken off, for the one place that builds it. */
export type Draft<T> = T extends Date
  ? T
  : T extends readonly (infer U)[]
    ? Draft<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Draft<T[K]> }
      : T;

export interface SettingDef {
  /** The key stored in `PlanSetting.key` and named in `PATCH /admin/plan-settings`. */
  key: string;
  /** Where the dashboard files it. */
  group: string;
  /** A short name in plain words. */
  label: string;
  unit: SettingUnit;
  /** The screens and routes that print or use the figure. */
  usedBy: readonly string[];
  /** A marker in the seed's `provisional` notes, or null when the owner named the figure. */
  provisional: string | null;
  /** The value when no row is stored: the seed's. */
  default: SettingValue;
  /**
   * Checks a value an admin sends and returns the one to store. Throws
   * `SettingInvalid` with a reason in plain words.
   */
  parse: (raw: unknown) => SettingValue;
  /** Puts the value into the live plan. Absent for a setting no plan field reads. */
  apply?: (plan: Draft<PlansConfig>, value: SettingValue) => void;
}

/** A value the registry refuses. The message completes "<key> ...". */
export class SettingInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingInvalid';
  }
}

/** The seed that is not in `plans.config.json` (src/plan-settings/plan-settings.defaults.json). */
export interface ExtrasDefaults {
  /** Marker id to why. */
  provisional: Readonly<Record<string, string>>;
  /** Setting key to its default; a key the registry does not know is refused at boot. */
  values: Readonly<Record<string, unknown>>;
}

/** Both seeds, read and checked at boot. */
export interface PlanSettingsDefaults {
  plans: PlansConfig;
  extras: ExtrasDefaults;
}
