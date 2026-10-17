import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  loadPlansConfig,
  PLANS_CONFIG_FILE,
  type PlansConfig,
} from '../plans/plans-config';
import { buildRegistry } from './plan-setting-registry';
import {
  SettingInvalid,
  type ExtrasDefaults,
  type PlanSettingsDefaults,
  type SettingDef,
} from './plan-setting-types';

/** The Nest token the checked seed is provided under. */
export const PLAN_SETTINGS_DEFAULTS = 'PLAN_SETTINGS_DEFAULTS';

/**
 * Where the seed that is not in `plans.config.json` is: beside the registry,
 * in the source tree, read at boot (the same way the plans file is).
 */
export const PLAN_SETTINGS_DEFAULTS_FILE = join(
  dirname(PLANS_CONFIG_FILE),
  '..',
  'plan-settings',
  'plan-settings.defaults.json',
);

/** The seed is unusable. Stops the server at boot; the message names the file and the key. */
export class PlanSettingsDefaultsError extends Error {
  constructor(file: string, problem: string) {
    super(`${basename(file)}: ${problem}. Fix the file and restart.`);
    this.name = 'PlanSettingsDefaultsError';
  }
}

function readExtras(file: string): ExtrasDefaults {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PlanSettingsDefaultsError(
      file,
      `cannot be read as JSON (${(e as Error).message})`,
    );
  }
  const o = raw as { provisional?: unknown; values?: unknown } | null;
  const plain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!plain(o) || !plain(o.provisional) || !plain(o.values)) {
    throw new PlanSettingsDefaultsError(
      file,
      'must be an object with "provisional" and "values" objects',
    );
  }
  for (const [id, why] of Object.entries(o.provisional)) {
    if (typeof why !== 'string' || why.trim() === '') {
      throw new PlanSettingsDefaultsError(
        file,
        `provisional "${id}" needs a reason in words`,
      );
    }
  }
  return {
    provisional: o.provisional as Record<string, string>,
    values: o.values,
  };
}

/**
 * Checks the registry against both seeds, whole: every default passes its own
 * check, every setting that needs a default has one, every marker has a
 * reason, and no seed value names a setting the registry does not have.
 */
export function checkRegistry(
  defs: readonly SettingDef[],
  plans: PlansConfig,
  extras: ExtrasDefaults,
  file: string = PLAN_SETTINGS_DEFAULTS_FILE,
): void {
  const keys = new Set(defs.map((d) => d.key));
  if (keys.size !== defs.length) {
    throw new PlanSettingsDefaultsError(file, 'two settings share one key');
  }
  for (const key of Object.keys(extras.values)) {
    if (!keys.has(key)) {
      throw new PlanSettingsDefaultsError(
        file,
        `values."${key}" is not a setting`,
      );
    }
  }
  for (const d of defs) {
    if (d.default === null) {
      // Only the lines under a pass and the event date may be unset.
      if (d.unit !== 'lines' && d.unit !== 'date') {
        throw new PlanSettingsDefaultsError(
          file,
          `values."${d.key}" is missing`,
        );
      }
    } else {
      try {
        d.parse(d.default);
      } catch (e) {
        if (!(e instanceof SettingInvalid)) throw e;
        throw new PlanSettingsDefaultsError(file, `"${d.key}" ${e.message}`);
      }
    }
    if (
      d.provisional !== null &&
      !(d.provisional in extras.provisional) &&
      !(d.provisional in plans.provisional)
    ) {
      throw new PlanSettingsDefaultsError(
        file,
        `provisional "${d.provisional}" (used by ${d.key}) has no reason`,
      );
    }
  }
}

/** Reads and checks both seeds. */
export function loadPlanSettingsDefaults(
  plansFile: string = PLANS_CONFIG_FILE,
  extrasFile: string = PLAN_SETTINGS_DEFAULTS_FILE,
): PlanSettingsDefaults {
  const plans = loadPlansConfig(plansFile);
  const extras = readExtras(extrasFile);
  checkRegistry(buildRegistry(plans, extras), plans, extras, extrasFile);
  return { plans, extras };
}
