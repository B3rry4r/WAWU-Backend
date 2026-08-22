import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminTokenService, type AdminTokenPair } from './admin-token.service';
import { toAdminUserView, type AdminUserView } from './admin-user-view.type';
import type { AdminLoginDto } from './dto/admin-login.dto';
import type { AdminRefreshDto } from './dto/admin-refresh.dto';

export interface AdminSession extends AdminTokenPair {
  admin: AdminUserView;
}

/**
 * Local credential login for the admin dashboard. This is the ONLY place in
 * this backend that authenticates anybody locally — every user identity lives
 * in WAWU ID and this service never calls it, never imports its client, and
 * never touches src/common/auth/*.
 *
 * Password hashing is argon2id (the library's default), which was already a
 * dependency of this project but unused: nothing here had a password to hash
 * until now.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  /**
   * Verified against when the email matches no admin, so a wrong email and a
   * wrong password cost the same time. Without it, "which emails are admins"
   * is readable off the response latency.
   */
  private decoyHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
  ) {}

  async login(dto: AdminLoginDto): Promise<AdminSession> {
    // Stored emails are lower-cased on the way in (scripts/seed-admin.ts), but
    // an operator typing "Ada@wawu.africa" into the dashboard must still get
    // in — matched case-insensitively rather than by normalising what is
    // stored.
    const admin = await this.prisma.adminUser.findFirst({
      where: { email: { equals: dto.email.trim(), mode: 'insensitive' } },
    });

    if (!admin) {
      await this.burnEqualTime(dto.password);
      throw new UnauthorizedException('Invalid email or password.');
    }

    let passwordMatches = false;
    try {
      passwordMatches = await argon2.verify(admin.passwordHash, dto.password);
    } catch (error) {
      // A malformed hash in the row (hand-edited, or written by something
      // other than the seed command) is an operational fault, not a login.
      this.logger.error(`Stored password hash for admin ${admin.id} could not be read`, error as Error);
      passwordMatches = false;
    }

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    // Checked only after the password verifies: a suspended admin gets a
    // truthful answer, while someone guessing emails learns nothing.
    if (admin.status !== 'active') {
      throw new ForbiddenException('This admin account is suspended.');
    }

    const updated = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    return { ...this.tokens.issuePair(updated), admin: toAdminUserView(updated) };
  }

  /**
   * Rotates a refresh token for a fresh pair. The refresh token is verified
   * with its OWN secret and audience (see AdminTokenService), so an access
   * token presented here is rejected, and vice versa.
   */
  async refresh(dto: AdminRefreshDto): Promise<AdminSession> {
    const claims = this.tokens.verifyRefreshToken(dto.refreshToken);
    const admin = await this.prisma.adminUser.findUnique({ where: { id: claims.sub } });

    if (!admin || admin.status !== 'active' || admin.tokenVersion !== claims.tokenVersion) {
      throw new UnauthorizedException('Admin session is invalid or has expired.');
    }

    return { ...this.tokens.issuePair(admin), admin: toAdminUserView(admin) };
  }

  /** Every admin account, for the superadmin-only roster on the dashboard. */
  async listAdmins(): Promise<AdminUserView[]> {
    const admins = await this.prisma.adminUser.findMany({ orderBy: [{ role: 'asc' }, { email: 'asc' }] });
    return admins.map(toAdminUserView);
  }

  private async burnEqualTime(password: string): Promise<void> {
    this.decoyHash ??= argon2.hash('unmatchable-decoy-password-for-timing-parity');
    try {
      await argon2.verify(await this.decoyHash, password);
    } catch {
      // Never throws in practice; the point is the work, not the answer.
    }
  }
}
