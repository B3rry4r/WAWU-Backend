// Mock WAWU ID — stands in for the real, separately-deployed identity
// service during local dev/testing in this sandbox, where no real WAWU ID
// credentials are available. Shape matches the real service exactly
// (confirmed via direct inspection of /workspace/projects/WAWU-ID):
// RS256 JWT, JWKS at /.well-known/jwks.json, same claim names.
//
// This is NOT a stand-in for product logic — it only issues/verifies
// identity tokens. All WAWUAfrica-specific state (creator status, KYC,
// subscriptions) lives in the new backend's own database, keyed by the
// `sub` claim these tokens carry.
const express = require("express");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// CORS -- the real WAWU ID enables this (main.ts: enableCors, credentials
// true, origin defaults to allow-all when ALLOWED_ORIGINS is unset -- see
// /workspace/projects/WAWU-ID/src/main.ts). Without it, WAWU-Web's browser
// client (auth.ts calling this service directly, cross-origin from :3000)
// gets silently blocked at the CORS-preflight level; every call falls
// through to auth.ts's mock-fallback branch instead, which looks like a
// working sign-in (a fake token gets stored) but every subsequent real
// Hub API call then 401s on that fake token -- a false-positive discovered
// live during Phase 8 E2E testing, not a hypothetical.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/**
 * The signing pair, generated on first run.
 *
 * This used to read two files that had to already be there, with
 * private.pem gitignored and public.pem COMMITTED. Two ways that goes wrong,
 * and both happened:
 *
 *  - A fresh clone has the public key and no private one, so the mock cannot
 *    start at all.
 *  - Regenerate the private key locally and the committed public one no
 *    longer matches it. The mock then signs tokens the Hub cannot verify, and
 *    every request 401s while the JWKS endpoint, the kid and the token all
 *    look perfectly correct. That cost an afternoon once.
 *
 * A local test double's keypair is not something to keep in a repo. It is
 * made here if it is missing, and the two halves cannot disagree because they
 * are always written together.
 */
function loadOrCreateKeypair() {
  const privPath = path.join(__dirname, "private.pem");
  const pubPath = path.join(__dirname, "public.pem");
  if (fs.existsSync(privPath)) {
    const privateKey = fs.readFileSync(privPath, "utf8");
    // The public half is derived, never read from disk, so a stale
    // public.pem cannot put the two out of step.
    const publicKey = crypto
      .createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    fs.writeFileSync(pubPath, publicKey);
    return { privateKey, publicKey };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(privPath, privateKey);
  fs.writeFileSync(pubPath, publicKey);
  console.log("[mock-wawu-id] generated a new signing keypair");
  return { privateKey, publicKey };
}

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = loadOrCreateKeypair();
const KID = "mock-wawu-id-key-1";
// The internal service key MUST match what the Hub API sends, and the Hub
// API reads it from the repo's own .env. Defaulting to a literal here is how
// this drifts: the key silently disagrees, /internal/users/lookup 401s, and
// every screen that resolves a real name quietly falls back to the handle —
// which reads as a name-resolution bug rather than a misconfigured mock.
// So read the same .env, and say out loud which key is in use.
function serviceKeyFromRepoEnv() {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const line = envFile
      .split("\n")
      .find((l) => l.trim().startsWith("WAWU_ID_INTERNAL_SERVICE_KEY="));
    if (!line) return null;
    return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}

const INTERNAL_SERVICE_KEY =
  process.env.WAWU_ID_INTERNAL_SERVICE_KEY ||
  serviceKeyFromRepoEnv() ||
  "dev-internal-service-key-not-secret";

// Seed test users — the new backend's own seed script mirrors these
// wawuUserId values when creating CreatorState/KYC/Subscription rows,
// so Phase 8's live-gate can log in as any of these and see matching
// WAWUAfrica-specific state.
const USERS = {
  "user@test.wawu.dev": {
    sub: "00000000-0000-4000-8000-000000000001",
    email: "user@test.wawu.dev",
    phone: "+2348000000001",
    firstName: "Adaeze",
    lastName: "Okonkwo",
    country: "Nigeria",
    verificationTier: "verified_user",
    trustScore: 40,
    status: "active",
    platformRefs: { wawuafricaAppUserId: "00000000-0000-4000-8000-000000000001" },
  },
  "creator-basic@test.wawu.dev": {
    sub: "00000000-0000-4000-8000-000000000002",
    email: "creator-basic@test.wawu.dev",
    phone: "+2348000000002",
    firstName: "Chidi",
    lastName: "Umeh",
    country: "Nigeria",
    verificationTier: "basic",
    trustScore: 20,
    status: "active",
    platformRefs: { wawuafricaAppUserId: "00000000-0000-4000-8000-000000000002" },
  },
  "creator-pro@test.wawu.dev": {
    sub: "00000000-0000-4000-8000-000000000003",
    email: "creator-pro@test.wawu.dev",
    phone: "+2348000000003",
    firstName: "Zainab",
    lastName: "Bello",
    country: "Nigeria",
    verificationTier: "certified_professional",
    trustScore: 85,
    status: "active",
    platformRefs: { wawuafricaAppUserId: "00000000-0000-4000-8000-000000000003" },
  },
};

function signAccessToken(claims) {
  return jwt.sign(claims, PRIVATE_KEY, { algorithm: "RS256", keyid: KID, expiresIn: "15m" });
}
function signRefreshToken(sub) {
  return jwt.sign({ sub, type: "refresh" }, PRIVATE_KEY, { algorithm: "RS256", keyid: KID, expiresIn: "30d" });
}

// The real WAWU ID's `user` response field is a DIFFERENT shape from the
// JWT claims (UserResponse: {id, fullName, ...} vs AccessTokenPayload:
// {sub, firstName, lastName, ...} — confirmed by direct inspection of
// /workspace/projects/WAWU-ID/src/auth/auth.service.ts). auth.ts (this
// backend's frontend, WAWU-Web) reads `response.user.id`/`.fullName` on
// every register/login/otp-verify call — the JWT claims shape alone
// (this mock's original USERS record) doesn't have those fields.
function toUserResponse(claims) {
  return {
    id: claims.sub,
    fullName: [claims.firstName, claims.lastName].filter(Boolean).join(" "),
    email: claims.email,
    phone: claims.phone,
    country: claims.country,
    state: claims.state ?? null,
    gender: claims.gender ?? null,
    occupation: claims.occupation ?? null,
    verificationTier: claims.verificationTier,
    trustScore: claims.trustScore,
    status: claims.status,
  };
}

function tokenPairFor(claims) {
  return {
    accessToken: signAccessToken(claims),
    refreshToken: signRefreshToken(claims.sub),
    user: toUserResponse(claims),
  };
}

app.get("/.well-known/jwks.json", (_req, res) => {
  const keyObject = crypto.createPublicKey(PUBLIC_KEY);
  const jwk = keyObject.export({ format: "jwk" });
  res.json({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
});

// Register — the real WAWU ID issues tokens immediately, no OTP step.
// Matches on email OR phone (both must be free, mirroring the real
// service's 409-on-either-taken behavior).
app.post("/auth/register", (req, res) => {
  const { fullName, email, phone, dialCode, country, state, gender, occupation, password } = req.body || {};
  if (!fullName || !email || !phone || !country || !password) {
    return res.status(400).json({ statusCode: 400, message: "fullName, email, phone, country, password are required" });
  }
  const taken = Object.values(USERS).find((u) => u.email === email || u.phone === phone);
  if (taken) {
    return res.status(409).json({ statusCode: 409, message: "An account with this email or phone already exists." });
  }
  const [firstName, ...rest] = String(fullName).trim().split(/\s+/);
  const sub = crypto.randomUUID();
  const claims = {
    sub,
    email,
    phone,
    dialCode: dialCode ?? null,
    firstName: firstName ?? fullName,
    lastName: rest.join(" ") || null,
    country,
    state: state ?? null,
    gender: gender ?? null,
    occupation: occupation ?? null,
    verificationTier: "basic",
    trustScore: 0,
    status: "active",
    platformRefs: { wawuafricaAppUserId: sub },
  };
  USERS[email] = claims;
  USERS[phone] = claims;
  res.status(201).json(tokenPairFor(claims));
});

// Mock login — accepts ANY password for a seeded identifier. This is a
// local test double, not a security boundary.
app.post("/auth/login", (req, res) => {
  const identifier = req.body?.identifier || req.body?.email;
  const user = USERS[identifier];
  if (!user) {
    return res.status(404).json({ code: "USER_NOT_IN_WAWUID", message: "No such test user" });
  }
  res.json(tokenPairFor(user));
});

app.post("/auth/otp/start", (req, res) => {
  res.json({ message: "OTP sent", expiresIn: 300, devOtp: "000000" });
});

app.post("/auth/otp/verify", (req, res) => {
  const identifier = req.body?.phone || req.body?.email;
  const user = Object.values(USERS).find((u) => u.phone === identifier || u.email === identifier) || USERS["user@test.wawu.dev"];
  res.json(tokenPairFor(user));
});

// Anti-enumeration: always the same message, matching the real service.
app.post("/auth/forgot-password", (_req, res) => {
  res.json({ message: "If an account exists, a reset code has been sent." });
});

// Email-link path only (this is a web frontend) — accepts any {token,email,password}
// for a known seeded email, matching the real service's shape.
app.post("/auth/reset-password", (req, res) => {
  const { token, email, password, identifier, code, newPassword } = req.body || {};
  if (token && email && password) {
    if (!USERS[email]) return res.status(400).json({ statusCode: 400, message: "Invalid or expired token" });
    return res.json({ message: "Password reset successfully" });
  }
  if (identifier && code && newPassword) {
    const user = USERS[identifier];
    if (!user) return res.status(400).json({ statusCode: 400, message: "Invalid or expired code" });
    return res.json(tokenPairFor(user));
  }
  res.status(400).json({ statusCode: 400, message: "Provide either {token,email,password} or {identifier,code,newPassword}" });
});

app.post("/auth/refresh", (req, res) => {
  try {
    const decoded = jwt.verify(req.body.refreshToken, PUBLIC_KEY, { algorithms: ["RS256"] });
    const user = Object.values(USERS).find((u) => u.sub === decoded.sub);
    if (!user) return res.status(401).json({ message: "invalid refresh token" });
    const { user: _unused, ...pair } = tokenPairFor(user);
    res.json(pair);
  } catch {
    res.status(401).json({ message: "invalid refresh token" });
  }
});

// Internal service-to-service surface — same X-Service-Key pattern as
// the real WAWU ID.
function requireServiceKey(req, res, next) {
  if (req.header("X-Service-Key") !== INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ message: "invalid service key" });
  }
  next();
}

app.patch("/internal/users/:userId/verification-tier", requireServiceKey, (req, res) => {
  const user = Object.values(USERS).find((u) => u.sub === req.params.userId);
  if (!user) return res.status(404).json({ message: "user not found" });
  const nextTier = req.body?.tier || req.body?.verificationTier;
  console.log(`[mock-wawu-id] elevating ${user.email} verificationTier -> ${nextTier}`);
  user.verificationTier = nextTier;
  res.json({ ok: true, userId: user.sub, verificationTier: user.verificationTier });
});

// The two-tick surface. Mirrors WAWU ID's new
// PATCH /internal/users/:userId/verification, which is how the Hub keeps
// identity as the source of truth for whether somebody is verified.
//
// One tick per call. `granted: false` is a REVOKE; a null "expiresAt"
// beside a real "verifiedAt" is a perpetual, admin-granted tick. Nothing here
// derives `verified` - that is the reading service's job, from the expiry.
app.patch("/internal/users/:userId/verification", requireServiceKey, (req, res) => {
  const user = Object.values(USERS).find((u) => u.sub === req.params.userId);
  if (!user) return res.status(404).json({ message: "user not found" });
  // Mirrors WAWU ID's UpdateVerificationDto exactly: { tick, granted,
  // expiresAt }. A mock that accepted a shape the real service rejects would
  // make the contract suite pass against an integration that 400s in
  // production, which is worse than no mock.
  const kind = req.body?.tick;
  if (kind !== "creator" && kind !== "professional") {
    return res.status(400).json({ message: "tick must be creator or professional" });
  }
  if (typeof req.body?.granted !== "boolean") {
    return res.status(400).json({ message: "granted must be a boolean" });
  }
  // Granting stamps verifiedAt here, the way the real service does. Revoking
  // clears BOTH columns, so the row reads as never-verified rather than as
  // lapsed.
  const verifiedAt = req.body.granted ? new Date().toISOString() : null;
  const verifiedUntil = req.body.granted ? (req.body?.expiresAt ?? null) : null;
  user.verification = user.verification ?? {
    creator: { verifiedAt: null, verifiedUntil: null },
    professional: { verifiedAt: null, verifiedUntil: null },
  };
  user.verification[kind] = { verifiedAt, verifiedUntil };
  console.log(
    `[mock-wawu-id] ${verifiedAt === null ? "revoking" : "granting"} ${kind} verification for ${user.email}`,
  );
  res.json({ ok: true, userId: user.sub, verification: user.verification });
});

// Mirrors WAWU-ID's POST /internal/users/lookup — display name and badge
// tier for a set of ids, so a sibling service can render real people in a
// list. Unknown ids are omitted, never returned as nulls.
app.post("/internal/users/lookup", requireServiceKey, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) {
    return res.status(400).json({ message: "ids must be a non-empty array" });
  }
  if (ids.length > 100) {
    return res.status(400).json({ message: "ids must contain at most 100 entries" });
  }
  const wanted = new Set(ids);
  const data = Object.values(USERS)
    .filter((u) => wanted.has(u.sub))
    .map((u) => ({
      id: u.sub,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
      verificationTier: u.verificationTier,
      verification: u.verification ?? {
        creator: { verifiedAt: null, verifiedUntil: null },
        professional: { verifiedAt: null, verifiedUntil: null },
      },
    }));
  res.json({ data });
});

// The data-export email (SETTINGS-04). Mirrors the route WAWU ID is to build
// (BACKEND_GAPS G-131): POST /internal/users/:userId/data-export
// { downloadUrl, expiresAt }. Like unpaid-warning, the Hub names the user and
// the link; WAWU ID owns the address and the wording, so the mock records
// "who was mailed what link" in an outbox the contract suite can read, and
// sends nothing.
const MAIL_OUTBOX = [];
app.post("/internal/users/:userId/data-export", requireServiceKey, (req, res) => {
  const user = Object.values(USERS).find((u) => u.sub === req.params.userId);
  if (!user) return res.status(404).json({ message: "user not found" });
  const { downloadUrl, expiresAt } = req.body ?? {};
  if (typeof downloadUrl !== "string" || !/^https?:\/\//.test(downloadUrl)) {
    return res.status(400).json({ message: "downloadUrl must be a URL" });
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    return res.status(400).json({ message: "expiresAt must be an ISO date" });
  }
  MAIL_OUTBOX.push({
    kind: "data-export",
    userId: user.sub,
    to: user.email,
    downloadUrl,
    expiresAt,
    sentAt: new Date().toISOString(),
  });
  res.json({ data: { sent: true } });
});
// The PIN reset code by email under WALLET_PROVIDER=nuvion (NUV-01, R-39: no
// SMS). Mirrors the route WAWU ID is to build (BACKEND_GAPS G-400):
// POST /internal/users/:userId/pin-reset-code { code, expiresInMinutes }.
// The Hub names the user and the code; WAWU ID owns the address and the
// wording, so the mock records who was mailed which code and sends nothing.
app.post("/internal/users/:userId/pin-reset-code", requireServiceKey, (req, res) => {
  const user = Object.values(USERS).find((u) => u.sub === req.params.userId);
  if (!user) return res.status(404).json({ message: "user not found" });
  const { code, expiresInMinutes } = req.body ?? {};
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: "code must be 6 digits" });
  }
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1) {
    return res.status(400).json({ message: "expiresInMinutes must be a whole number" });
  }
  MAIL_OUTBOX.push({
    kind: "pin-reset-code",
    userId: user.sub,
    to: user.email,
    code,
    expiresInMinutes,
    sentAt: new Date().toISOString(),
  });
  res.json({ data: { sent: true } });
});
app.get("/internal/mail-outbox", requireServiceKey, (_req, res) => {
  res.json({ data: MAIL_OUTBOX });
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "mock-wawu-id" }));

console.log(
  INTERNAL_SERVICE_KEY === "dev-internal-service-key-not-secret"
    ? "mock-wawu-id: WARNING — using the built-in service key. If the Hub API's .env sets WAWU_ID_INTERNAL_SERVICE_KEY, /internal/* will 401 and names will fall back to handles."
    : "mock-wawu-id: internal service key loaded (matches the Hub API .env)",
);

const PORT = process.env.MOCK_WAWU_ID_PORT || 4001;
app.listen(PORT, () => {
  console.log(`[mock-wawu-id] listening on :${PORT}`);
  console.log(`[mock-wawu-id] JWKS: http://localhost:${PORT}/.well-known/jwks.json`);
  console.log(`[mock-wawu-id] seeded users: ${Object.keys(USERS).join(", ")}`);
});
