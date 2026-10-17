import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { AdminActor } from '../common/audit/admin-ops-audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { PlansConfig } from '../plans/plans-config';
import { buildRegistry } from './plan-setting-registry';
import {
  SettingInvalid,
  type Draft,
  type SettingDef,
  type SettingValue,
  type PlanSettingsDefaults,
} from './plan-setting-types';
import {
  checkRegistry,
  PLAN_SETTINGS_DEFAULTS,
} from './plan-settings-defaults';
import type { PlansSource } from './live-plans-config';

/** How often a process looks again for a change another process saved. */
export const PLAN_SETTINGS_REFRESH_SECONDS = 15;

/** The most settings one request may change. */
const MAX_CHANGES_PER_REQUEST = 100;

/** One setting as the dashboard reads it. */
export interface PlanSettingView {
  key: string;
  group: string;
  label: string;
  unit: SettingDef['unit'];
  /** The screens and routes that print or use the figure. */
  usedBy: string[];
  /** The value in force now: the stored one, or the default. */
  value: SettingValue;
  /** What the value is when nothing is stored. */
  default: SettingValue;
  source: 'default' | 'set';
  /** Set when the owner did not name the figure; it is the board's value until confirmed. */
  provisional: { id: string; why: string } | null;
  updatedAt: string | null;
}

export interface PlanSettingsView {
  settings: PlanSettingView[];
}

interface Snapshot {
  config: PlansConfig;
  stored: Map<string, { value: SettingValue; updatedAt: Date }>;
}

/** A change a request asked for: a new value, or null to put the default back. */
type Change = { key: string; def: SettingDef; value: SettingValue | null };

function same(a: SettingValue, b: SettingValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The launch figures as admin settings (TIER-06, R-65).
 *
 * The plan is the seed (`plans.config.json` and `plan-settings.defaults.json`)
 * with the rows an admin has saved laid over it. That result is kept in
 * memory so a reader never waits on the database: `current()` is a plain read.
 * The cache follows a change two ways. The process that saved the change
 * reloads at once, so the next quote it answers uses the new figure with no
 * restart; any other process picks it up within
 * `PLAN_SETTINGS_REFRESH_SECONDS`.
 *
 * Nothing here holds a transaction or a connection across a network call:
 * saving is one short transaction of database writes, and a reload is one
 * read.
 */
@Injectable()
export class PlanSettingsService
  implements PlansSource, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlanSettingsService.name);
  private readonly defs: SettingDef[];
  private readonly byKey: Map<string, SettingDef>;
  private snapshot: Snapshot;
  /** Counts loads as they start; a load that started earlier never replaces a later one. */
  private started = 0;
  private applied = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLAN_SETTINGS_DEFAULTS) private readonly seed: PlanSettingsDefaults,
  ) {
    this.defs = buildRegistry(seed.plans, seed.extras);
    checkRegistry(this.defs, seed.plans, seed.extras);
    this.byKey = new Map(this.defs.map((d) => [d.key, d]));
    this.snapshot = this.build(new Map());
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, PLAN_SETTINGS_REFRESH_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The plan now: the seed with the saved settings laid over it. A plain read. */
  current(): PlansConfig {
    return this.snapshot.config;
  }

  /** The value in force for a key. Throws for a key that is not a setting. */
  value(key: string): SettingValue {
    const def = this.mustHave(key);
    return this.snapshot.stored.get(key)?.value ?? def.default;
  }

  /** The value of a setting that holds a whole number, for the tasks that read one. */
  number(key: string): number {
    const v = this.value(key);
    if (typeof v !== 'number') {
      throw new Error(`The setting ${key} does not hold a number.`);
    }
    return v;
  }

  /** The value of a setting that holds a piece of text (a time of day, a date). */
  text(key: string): string {
    const v = this.value(key);
    if (typeof v !== 'string') {
      throw new Error(`The setting ${key} does not hold text.`);
    }
    return v;
  }

  private mustHave(key: string): SettingDef {
    const def = this.byKey.get(key);
    if (!def) throw new Error(`There is no setting ${key}.`);
    return def;
  }

  private build(stored: Snapshot['stored']): Snapshot {
    const draft = structuredClone(this.seed.plans) as Draft<PlansConfig>;
    for (const d of this.defs) {
      const v = stored.get(d.key)?.value ?? d.default;
      if (d.apply && v !== null) d.apply(draft, v);
    }
    return { config: draft, stored };
  }

  /**
   * Reads the saved rows and rebuilds the plan. A failed read keeps the plan
   * already held. A row that fails its own check (written outside this
   * service) or names no setting is skipped and logged: the default is used.
   */
  async refresh(): Promise<void> {
    const mine = ++this.started;
    try {
      const rows = await this.prisma.planSetting.findMany();
      const stored: Snapshot['stored'] = new Map();
      for (const row of rows) {
        const def = this.byKey.get(row.key);
        if (!def) {
          this.logger.error(
            `Ignored a saved setting that is not known: ${row.key}`,
          );
          continue;
        }
        try {
          stored.set(row.key, {
            value: def.parse(row.value),
            updatedAt: row.updatedAt,
          });
        } catch (e) {
          if (!(e instanceof SettingInvalid)) throw e;
          this.logger.error(
            `Ignored the saved setting ${row.key}, which ${e.message}. Its default is used.`,
          );
        }
      }
      if (mine > this.applied) {
        this.applied = mine;
        this.snapshot = this.build(stored);
      }
    } catch (e) {
      this.logger.warn(
        `Could not reload the plan settings, keeping the ones held: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Every setting, with its value, its default, its provenance and where it is used. */
  describe(): PlanSettingsView {
    const why = (id: string) =>
      this.seed.extras.provisional[id] ?? this.seed.plans.provisional[id] ?? '';
    return {
      settings: this.defs.map((d) => {
        const row = this.snapshot.stored.get(d.key);
        return {
          key: d.key,
          group: d.group,
          label: d.label,
          unit: d.unit,
          usedBy: [...d.usedBy],
          value: row?.value ?? d.default,
          default: d.default,
          source: row ? 'set' : 'default',
          provisional: d.provisional
            ? { id: d.provisional, why: why(d.provisional) }
            : null,
          updatedAt: row?.updatedAt.toISOString() ?? null,
        };
      }),
    };
  }

  /**
   * Saves the changes in one short transaction, with one audit row per
   * setting that really changed (old and new value, who). A `null` value puts
   * a setting back to its default. Every value is checked first and one bad
   * value refuses the whole request, so a request is all or nothing. A
   * value equal to the one in force writes nothing.
   */
  async set(admin: AdminActor, body: unknown): Promise<PlanSettingsView> {
    const changes = this.parse(body);
    await this.prisma.$transaction(async (tx) => {
      for (const c of changes) {
        const row = await tx.planSetting.findUnique({ where: { key: c.key } });
        let before: SettingValue = c.def.default;
        if (row) {
          try {
            before = c.def.parse(row.value);
          } catch (e) {
            if (!(e instanceof SettingInvalid)) throw e;
          }
        }
        const after = c.value ?? c.def.default;
        if (c.value === null) {
          if (!row) continue;
          await tx.planSetting.delete({ where: { key: c.key } });
        } else {
          if (same(before, after)) continue;
          await tx.planSetting.upsert({
            where: { key: c.key },
            create: {
              key: c.key,
              value: c.value as never,
              updatedByAdminId: admin.id,
            },
            update: { value: c.value as never, updatedByAdminId: admin.id },
          });
        }
        await tx.adminOpsAudit.create({
          data: {
            resource: 'plan_setting',
            resourceId: c.key,
            subjectWawuId: '',
            action: 'plan_setting_set',
            detail: {
              key: c.key,
              from: before,
              to: after,
              reset: c.value === null,
            } as never,
            actedByAdminId: admin.id,
            actedByAdminEmail: admin.email,
            actedByAdminRole: admin.role,
          },
        });
      }
    });
    // Reload at once so the very next quote in this process uses the new figure.
    await this.refresh();
    return this.describe();
  }

  private parse(body: unknown): Change[] {
    const settings = (body as { settings?: unknown } | null)?.settings;
    if (
      typeof settings !== 'object' ||
      settings === null ||
      Array.isArray(settings)
    ) {
      throw new BadRequestException(
        'Send { "settings": { "<key>": <value> } }. A null value puts a setting back to its default.',
      );
    }
    const entries = Object.entries(settings);
    if (entries.length === 0 || entries.length > MAX_CHANGES_PER_REQUEST) {
      throw new BadRequestException(
        `Change from 1 to ${MAX_CHANGES_PER_REQUEST} settings at a time.`,
      );
    }
    return entries.map(([key, raw]): Change => {
      const def = this.byKey.get(key);
      if (!def) throw new BadRequestException(`${key} is not a setting.`);
      if (raw === null) return { key, def, value: null };
      try {
        return { key, def, value: def.parse(raw) };
      } catch (e) {
        if (e instanceof SettingInvalid) {
          throw new BadRequestException(`${key} ${e.message}.`);
        }
        throw e;
      }
    });
  }
}
