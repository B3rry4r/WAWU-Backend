import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type KeyObject,
} from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RegisterApprovalDeviceDto } from '../dto/money-request.dto';
import type { ApprovalBiometricKind } from '../dto/money-enums';
import { MoneyError } from '../money-error';
import type {
  ApprovalChallengeView,
  ApprovalDeviceView,
} from '../money-view.type';
import { PinResetSettings } from './pin-reset-config';
import { TransactionPinService } from './transaction-pin.service';

/** The first line of every signed approval: names the scheme and its version. */
export const APPROVAL_MESSAGE_TAG = 'wawu-device-approval-v1';

/** `v1.<challengeId>.<signature>`: a uuid and a DER signature, base64url. */
const APPROVAL_FORMAT =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{8,200})$/;

const REFUSED_MESSAGE =
  'Your fingerprint or face could not approve this. Use your PIN.';
const KEY_MESSAGE = 'publicKey is not a P-256 public key.';

/** What the request the phone signed looks like to the server. */
export interface ApprovedRequest {
  method: string;
  /** The path and query as sent, `/api/hub/...`. */
  url: string;
  /** The exact body bytes; empty when there is no body. */
  body: Buffer;
}

/**
 * The text a phone signs for one approval (CONVENTIONS.md section 5): the
 * scheme, the challenge (its id and its random bytes), the phone, and the
 * request it approves (method, path with query, SHA-256 of the exact body).
 * Lines joined by `\n`. So an approval works once, for one phone, for one
 * request: it cannot be moved to another payment, amount or recipient.
 */
export function approvalMessage(args: {
  challengeId: string;
  challenge: string;
  deviceId: string;
  request: ApprovedRequest;
}): string {
  return [
    APPROVAL_MESSAGE_TAG,
    args.challengeId,
    args.challenge,
    args.deviceId,
    args.request.method.toUpperCase(),
    args.request.url,
    createHash('sha256').update(args.request.body).digest('hex'),
  ].join('\n');
}

/** A P-256 public key from SubjectPublicKeyInfo DER (base64url), or null. */
export function readApprovalKey(spki: string): KeyObject | null {
  try {
    const key = createPublicKey({
      key: Buffer.from(spki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    // P-256 has no small subgroup, and OpenSSL refuses a point that is not
    // on the curve, so a registered key cannot be one that signs anything.
    return key.asymmetricKeyType === 'ec' &&
      key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
      ? key
      : null;
  } catch {
    return null;
  }
}

/** `403 device_approval_refused`: the app shows "<Name> failed. Use your PIN." */
export function deviceApprovalRefused(): MoneyError {
  return new MoneyError('device_approval_refused', REFUSED_MESSAGE);
}

const refused = deviceApprovalRefused;

function isNoMatch(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2025'
  );
}

type DeviceRow = {
  deviceId: string;
  biometric: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

function deviceView(row: DeviceRow | null): ApprovalDeviceView {
  if (!row) {
    return {
      registered: false,
      deviceId: null,
      biometric: null,
      registeredAt: null,
      lastUsedAt: null,
    };
  }
  return {
    registered: true,
    deviceId: row.deviceId,
    biometric: row.biometric as ApprovalBiometricKind,
    registeredAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * The phone that may approve with a fingerprint or a face instead of the
 * PIN (task MONEY-14, W11, W35; R-26; docs/contract/CONVENTIONS.md section 5).
 *
 * The approval is a key the phone holds, checked here, never a "true" the
 * app sends: the phone makes a P-256 key pair whose private half only its
 * biometric unlocks, registers the public half with the PIN (PUT
 * /money/device), and approves a request by signing a one-time challenge
 * together with that exact request. So:
 * - an approval from a phone that is not the registered one, a wrong
 *   signature, a used or expired challenge, or another person's challenge is
 *   `403 device_approval_refused`;
 * - a refused approval never uses up a PIN try, and a passed one does not
 *   reset the count (the PIN is not involved);
 * - while the PIN is locked, a passed approval is refused as `423
 *   pin_locked` too (Default (agent), owner may override: a lock means
 *   someone was guessing, so nothing approves until it ends or a reset);
 * - one phone per person: registering another replaces it, and a PIN reset
 *   by code turns it off (PinResetService).
 */
@Injectable()
export class ApprovalDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pins: TransactionPinService,
    private readonly settings: PinResetSettings,
  ) {}

  /** GET /money/device. */
  async view(wawuUserId: string): Promise<ApprovalDeviceView> {
    return deviceView(
      await this.prisma.approvalDevice.findUnique({ where: { wawuUserId } }),
    );
  }

  /** PUT /money/device. The PIN has been checked by the guard. */
  async register(
    wawuUserId: string,
    dto: RegisterApprovalDeviceDto,
  ): Promise<ApprovalDeviceView> {
    if (!readApprovalKey(dto.publicKey)) {
      // The same shape as a malformed field: a key that is not a key.
      throw new BadRequestException(KEY_MESSAGE);
    }
    const now = new Date();
    const fields = {
      // A new id on every registration, so the replaced phone's challenges
      // and its own idea of "I am the registered phone" both stop working.
      deviceId: randomUUID(),
      publicKey: dto.publicKey,
      biometric: dto.biometric,
      lastUsedAt: null,
      createdAt: now,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.approvalChallenge.deleteMany({ where: { wawuUserId } });
      return tx.approvalDevice.upsert({
        where: { wawuUserId },
        create: { wawuUserId, ...fields },
        update: fields,
      });
    });
    return deviceView(row);
  }

  /** DELETE /money/device: turns biometric approval off. */
  async remove(wawuUserId: string): Promise<ApprovalDeviceView> {
    await this.prisma.$transaction([
      this.prisma.approvalChallenge.deleteMany({ where: { wawuUserId } }),
      this.prisma.approvalDevice.deleteMany({ where: { wawuUserId } }),
    ]);
    return deviceView(null);
  }

  /** POST /money/device/challenge: one challenge for the registered phone. */
  async challenge(wawuUserId: string): Promise<ApprovalChallengeView> {
    const device = await this.prisma.approvalDevice.findUnique({
      where: { wawuUserId },
      select: { deviceId: true },
    });
    if (!device) throw refused();
    const now = new Date();
    // Used and expired challenges are of no further use: drop them.
    await this.prisma.approvalChallenge.deleteMany({
      where: {
        wawuUserId,
        OR: [{ usedAt: { not: null } }, { expiresAt: { lte: now } }],
      },
    });
    const row = await this.prisma.approvalChallenge.create({
      data: {
        wawuUserId,
        deviceId: device.deviceId,
        challenge: randomBytes(32).toString('base64url'),
        expiresAt: new Date(now.getTime() + this.settings.approvalMs),
      },
    });
    return {
      challengeId: row.id,
      challenge: row.challenge,
      deviceId: row.deviceId,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /**
   * Checks an `X-Device-Approval` value for `request` and the signed-in
   * person. Throws `device_approval_refused`, or `pin_locked` /
   * `pin_not_set` for a signature that passed. Never touches a PIN try.
   */
  async approve(
    wawuUserId: string,
    header: string,
    request: ApprovedRequest,
  ): Promise<void> {
    const parts = APPROVAL_FORMAT.exec(header);
    if (!parts) throw refused();
    const [, challengeId, signature] = parts;

    // The challenge is used up by this approval, right or wrong.
    let challenge: { id: string; deviceId: string; challenge: string };
    try {
      challenge = await this.prisma.approvalChallenge.update({
        where: {
          id: challengeId,
          wawuUserId,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
        select: { id: true, deviceId: true, challenge: true },
      });
    } catch (err) {
      if (isNoMatch(err)) throw refused();
      throw err;
    }

    const device = await this.prisma.approvalDevice.findUnique({
      where: { wawuUserId },
    });
    if (!device || device.deviceId !== challenge.deviceId) throw refused();
    const key = readApprovalKey(device.publicKey);
    if (!key) throw refused();

    const message = approvalMessage({
      challengeId: challenge.id,
      challenge: challenge.challenge,
      deviceId: device.deviceId,
      request,
    });
    let good = false;
    try {
      good = verify(
        'sha256',
        Buffer.from(message, 'utf8'),
        { key, dsaEncoding: 'der' },
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      good = false;
    }
    if (!good) throw refused();

    // A real approval, from the registered phone. The PIN's lock still holds.
    await this.pins.assertNotLocked(wawuUserId);
    await this.prisma.approvalDevice.updateMany({
      where: { wawuUserId, deviceId: device.deviceId },
      data: { lastUsedAt: new Date() },
    });
  }
}
