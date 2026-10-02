#!/usr/bin/env node
/*
 * Plants the three seeded Hub accounts (prisma/seed.ts) in a LOCAL wawu-id
 * database, with the same user ids, so each one can sign in through the real
 * wawu-id login and land on the Hub data the seed gave it.
 *
 *   WAWU_ID_DATABASE_URL=postgresql://... node scripts/local/seed-wawu-id.js
 *
 * Every account gets the same local password (LOCAL_SEED_PASSWORD, default
 * below) and a verified email, because wawu-id refuses to sign in an
 * unverified email. Re-running repairs the rows: same id, same email, same
 * password.
 *
 * Refuses to run against anything but a database on this machine, and never
 * when NODE_ENV is production. These are fictional people.
 */
const { Client } = require('pg');
const argon2 = require('argon2');

const DEFAULT_PASSWORD = 'wawu-local-2026';

// Same ids, emails and phones as prisma/seed.ts and mock-wawu-id/server.js.
const ACCOUNTS = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'user@test.wawu.dev',
    phone: '+2348000000001',
    firstName: 'Adaeze',
    lastName: 'Okonkwo',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    email: 'creator-basic@test.wawu.dev',
    phone: '+2348000000002',
    firstName: 'Chidi',
    lastName: 'Umeh',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    email: 'creator-pro@test.wawu.dev',
    phone: '+2348000000003',
    firstName: 'Zainab',
    lastName: 'Bello',
  },
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function refuseUnlessLocal(url) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed wawu-id: NODE_ENV is production.');
  }
  if (!url) {
    throw new Error('Refusing to seed wawu-id: WAWU_ID_DATABASE_URL is unset.');
  }
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('Refusing to seed wawu-id: WAWU_ID_DATABASE_URL is not a URL.');
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to seed wawu-id: database host "${host}" is not this machine. This script only writes to a local database.`,
    );
  }
}

async function main() {
  const url = process.env.WAWU_ID_DATABASE_URL;
  refuseUnlessLocal(url);
  const password = process.env.LOCAL_SEED_PASSWORD || DEFAULT_PASSWORD;
  if (password.length < 8) {
    throw new Error('LOCAL_SEED_PASSWORD must be at least 8 characters (wawu-id refuses shorter).');
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const passwordHash = await argon2.hash(password);
    for (const a of ACCOUNTS) {
      await client.query(
        `INSERT INTO wawu_users
           (id, email, phone, first_name, last_name, country, password_hash,
            verification_tier, trust_score, status, email_verified, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'Nigeria', $6,
                 'basic'::"VerificationTier", 0, 'active'::"UserStatus", true, now())
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           password_hash = EXCLUDED.password_hash,
           status = EXCLUDED.status,
           email_verified = true,
           updated_at = now()`,
        [a.id, a.email, a.phone, a.firstName, a.lastName, passwordHash],
      );
      console.log(`wawu-id seed: ${a.email} (${a.id})`);
    }
  } finally {
    await client.end();
  }
  console.log(`wawu-id seed: ${ACCOUNTS.length} accounts, password "${password}"`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
