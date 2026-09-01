import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import type { HostedLinkDto } from './dto/hosted-link.dto';

/**
 * Flutterwave's HOSTED checkout, as an alternative to the inline modal.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The inline SDK authenticates with a PUBLIC key. The public key on this
 * account is rejected by Flutterwave ("Invalid public key passed"), verified
 * against their live checkout, while the SECRET key works fine — it serves the
 * bills API and mints hosted links. So every payment in the product was dead
 * for a reason no amount of application code could fix.
 *
 * `POST /v3/payments` needs only the secret key. It returns a URL, the payer
 * completes the charge on Flutterwave's own page, and Flutterwave sends them
 * back to `redirectUrl` with the transaction id. Nothing about verification
 * changes: the returned id is still only a claim until the owning resource's
 * /verify endpoint re-checks it server-side.
 *
 * ── WHY IT IS ONE ENDPOINT AND NOT A REWRITE ───────────────────────────────
 * Every init endpoint in the product already records a PendingCharge keyed by
 * txRef and already has a /verify. This mints a link for a txRef that has
 * ALREADY been through one of them, so the money path, the amounts and the
 * verification all stay exactly where they were.
 */
@Injectable()
export class PaymentLinkService {
  private readonly logger = new Logger(PaymentLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const key = this.config.get<string>('FLUTTERWAVE_SECRET_KEY');
    if (!key) throw new BadGatewayException('Payments are not configured on this server.');
    return key;
  }

  /**
   * The allowed redirect targets.
   *
   * An open redirect on a payment return is how a payer gets sent to a
   * lookalike page after paying, so the host must be one this platform owns.
   * CORS_ORIGIN is already the list of front-ends we serve, so it is reused
   * rather than maintained twice.
   */
  private assertRedirectAllowed(redirectUrl: string): void {
    const allowed = (this.config.get<string>('CORS_ORIGIN') ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    // Nothing configured means a local dev box, where any localhost is fine
    // and nothing else is reachable anyway.
    if (allowed.length === 0) return;
    let origin: string;
    try {
      origin = new URL(redirectUrl).origin;
    } catch {
      throw new BadRequestException('That redirect address is not valid.');
    }
    if (!allowed.includes(origin)) {
      throw new BadRequestException('That redirect address is not allowed.');
    }
  }

  /**
   * The amount and owner for a txRef, from whichever table recorded it.
   *
   * Every money flow in this product writes its own row before opening a
   * checkout, but they do not all write a PendingCharge — subscriptions and
   * DMs do, while orders, bills and purchases carry the reference on their own
   * record. So this asks each of them rather than assuming one table, and a
   * txRef nothing recognises gets no link at all.
   *
   * That is the whole point of the lookup: without it this endpoint would mint
   * a Flutterwave payment page for any amount anybody asked for, under our
   * account.
   */
  private async resolveCharge(
    txRef: string,
  ): Promise<{ amount: number; owner: string | null } | null> {
    const pending = await this.prisma.pendingCharge.findUnique({ where: { txRef } });
    if (pending) return { amount: pending.expectedAmount, owner: pending.wawuUserId };

    const [purchase, dm, credit, bill, order, shop] = await Promise.all([
      this.prisma.purchase.findUnique({ where: { flutterwaveTxRef: txRef }, select: { amount: true, buyerWawuId: true } }),
      this.prisma.directMessage.findUnique({ where: { flutterwaveTxRef: txRef }, select: { amount: true, senderWawuId: true } }),
      this.prisma.creditPurchase.findUnique({ where: { flutterwaveTxRef: txRef }, select: { amount: true, userWawuId: true } }),
      this.prisma.billPayment.findUnique({ where: { flutterwaveTxRef: txRef }, select: { amount: true, buyerWawuId: true } }),
      this.prisma.eventOrder.findUnique({ where: { flutterwaveTxRef: txRef }, select: { amountNaira: true, buyerWawuId: true } }),
      this.prisma.shopOrder.findUnique({ where: { flutterwaveTxRef: txRef }, select: { totalNaira: true, buyerWawuId: true } }),
    ]);

    if (purchase) return { amount: purchase.amount, owner: purchase.buyerWawuId };
    if (dm) return { amount: dm.amount, owner: dm.senderWawuId };
    if (credit) return { amount: credit.amount, owner: credit.userWawuId };
    if (bill) return { amount: bill.amount, owner: bill.buyerWawuId };
    if (order) return { amount: order.amountNaira, owner: order.buyerWawuId };
    if (shop) return { amount: shop.totalNaira, owner: shop.buyerWawuId };
    return null;
  }

  async create(wawuUserId: string, dto: HostedLinkDto): Promise<{ link: string }> {
    this.assertRedirectAllowed(dto.redirectUrl);

    const charge = await this.resolveCharge(dto.txRef);
    if (!charge || (charge.owner !== null && charge.owner !== wawuUserId)) {
      throw new NotFoundException('No matching payment attempt was found.');
    }

    const amount = charge.amount;

    let res: Response;
    try {
      res = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secret()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: dto.txRef,
          amount: String(amount),
          currency: dto.currency ?? 'NGN',
          redirect_url: dto.redirectUrl,
          payment_options: 'card,banktransfer,ussd',
          customer: { email: dto.customerEmail },
          customizations: {
            title: dto.title,
            description: dto.description,
          },
        }),
      });
    } catch (e) {
      this.logger.error(`Hosted link request failed: ${String(e)}`);
      throw new BadGatewayException('Could not reach the payment provider.');
    }

    const payload = (await res.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
      data?: { link?: string };
    };
    if (!res.ok || payload.status !== 'success' || !payload.data?.link) {
      this.logger.warn(`Hosted link rejected: ${payload.message ?? res.status}`);
      throw new BadGatewayException(
        payload.message ?? 'The payment provider would not open a checkout.',
      );
    }
    return { link: payload.data.link };
  }
}
