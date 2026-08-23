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

const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, "private.pem"), "utf8");
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, "public.pem"), "utf8");
const KID = "mock-wawu-id-key-1";
const INTERNAL_SERVICE_KEY = process.env.WAWU_ID_INTERNAL_SERVICE_KEY || "dev-internal-service-key-not-secret";

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
    }));
  res.json({ data });
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "mock-wawu-id" }));

const PORT = process.env.MOCK_WAWU_ID_PORT || 4001;
app.listen(PORT, () => {
  console.log(`[mock-wawu-id] listening on :${PORT}`);
  console.log(`[mock-wawu-id] JWKS: http://localhost:${PORT}/.well-known/jwks.json`);
  console.log(`[mock-wawu-id] seeded users: ${Object.keys(USERS).join(", ")}`);
});
