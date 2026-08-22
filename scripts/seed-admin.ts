// First-superadmin seed for the admin dashboard.
//
// Deliberately NOT part of prisma/seed.ts: that script seeds app fixtures for
// the three mock WAWU ID users and is run routinely against dev and test
// databases, including in CI. An admin credential is not fixture data, so it
// gets its own command with its own env vars and no default password
// anywhere in the repo.
//
// Run:
//   ADMIN_SEED_EMAIL=ops@wawu.africa \
//   ADMIN_SEED_PASSWORD='<a real password>' \
//   ADMIN_SEED_NAME='Ada Operator' \
//   npm run admin:seed
//
// Idempotent: an existing admin with that email is left exactly as it is
// (including its password) unless ADMIN_SEED_RESET_PASSWORD=true, which
// re-hashes the supplied password AND bumps tokenVersion so every token
// already issued to that admin stops working.
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { PrismaClient } from '../generated/prisma/client';
import { AdminRole } from '../generated/prisma/enums';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const email = (process.env.ADMIN_SEED_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_SEED_PASSWORD ?? '';
const name = (process.env.ADMIN_SEED_NAME ?? '').trim();
const resetPassword = process.env.ADMIN_SEED_RESET_PASSWORD === 'true';

// A minimum, not a policy: the point is that nobody seeds "admin123" into a
// production dashboard because the script let them.
const MIN_PASSWORD_LENGTH = 12;

if (!email || !password || !name) {
  console.error(
    'ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD and ADMIN_SEED_NAME must all be set. No credential is defaulted here on purpose.',
  );
  process.exit(1);
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`ADMIN_SEED_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const existing = await prisma.adminUser.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  });

  if (existing && !resetPassword) {
    console.log(
      `Admin ${existing.email} already exists (role ${existing.role}, status ${existing.status}). Nothing changed. ` +
        'Set ADMIN_SEED_RESET_PASSWORD=true to reset its password and revoke its outstanding tokens.',
    );
    return;
  }

  const passwordHash = await argon2.hash(password);

  if (existing) {
    const updated = await prisma.adminUser.update({
      where: { id: existing.id },
      // tokenVersion is what makes the reset real: without the bump, every
      // access and refresh token minted before the reset keeps working.
      data: { passwordHash, status: 'active', tokenVersion: { increment: 1 } },
    });
    console.log(`Reset password for ${updated.email} and revoked its outstanding tokens.`);
    return;
  }

  const created = await prisma.adminUser.create({
    data: { email, name, passwordHash, role: AdminRole.superadmin },
  });
  console.log(`Created superadmin ${created.email} (${created.id}).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
