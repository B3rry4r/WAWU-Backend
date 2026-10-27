import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';

/** How long after a start, and how often after that, the Hub looks for moves nobody has been told about. */
const FIRST_LOOK_MS = 30_000;
const LOOK_EVERY_MS = 10 * 60_000;
/** The most moves told in one look. */
const BATCH = 200;

/**
 * Tells each person once about each price the price-list migration moved
 * (PRICE-LIST, R-101 point 8): "The price of {title} is now ₦{price}, the
 * nearest on the price list."
 *
 * The migration writes a `PriceListMove` row for every move with `notifiedAt`
 * empty. Here each row is claimed and its notification written in ONE
 * transaction (`emitOrThrow`), so a row is told exactly once however many
 * servers look at once: the second claim finds `notifiedAt` set. A failure
 * rolls the claim back and the next look tries again. No network call is made
 * inside the transaction (the push goes out later, from the notification row).
 */
@Injectable()
export class PriceMoveNoticeService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PriceMoveNoticeService.name);
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    // Under a test the timers would keep a worker alive; the specs call
    // `sendPending()` themselves.
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return;
    const look = () => {
      void this.sendPending().catch((e: unknown) =>
        this.logger.error(
          'Could not tell owners about moved prices',
          e instanceof Error ? e.stack : String(e),
        ),
      );
    };
    this.timer = setTimeout(look, FIRST_LOOK_MS);
    this.timer.unref();
    this.interval = setInterval(look, LOOK_EVERY_MS);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  /** Tells every owner not yet told. Returns how many notices were written. */
  async sendPending(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const pending = await this.prisma.priceListMove.findMany({
        where: { notifiedAt: null },
        select: { id: true },
        orderBy: { movedAt: 'asc' },
        take: BATCH,
      });
      let told = 0;
      for (const { id } of pending) {
        try {
          told += await this.tell(id);
        } catch (e) {
          this.logger.error(
            `Could not tell the owner about moved price ${id}`,
            e instanceof Error ? e.stack : String(e),
          );
        }
      }
      return told;
    } finally {
      this.busy = false;
    }
  }

  private async tell(id: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.priceListMove.updateMany({
        where: { id, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
      if (claimed.count === 0) return 0;
      const move = await tx.priceListMove.findUniqueOrThrow({ where: { id } });
      await this.notifications.emitOrThrow(
        {
          kind: 'price_moved',
          userWawuId: move.ownerWawuId,
          itemTitle: move.title,
          newPrice: Number(move.newPriceKobo / 100n),
        },
        tx,
      );
      return 1;
    });
  }
}
