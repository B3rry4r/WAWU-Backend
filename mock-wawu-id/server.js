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

app.get("/.well-known/jwks.json", (_req, res) => {
  const keyObject = crypto.createPublicKey(PUBLIC_KEY);
  const jwk = keyObject.export({ format: "jwk" });
  res.json({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
});

// Mock login — accepts ANY password for a seeded identifier. This is a
// local test double, not a security boundary.
app.post("/auth/login", (req, res) => {
  const identifier = req.body?.identifier || req.body?.email;
  const user = USERS[identifier];
  if (!user) {
    return res.status(404).json({ code: "USER_NOT_IN_WAWUID", message: "No such test user" });
  }
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user.sub);
  res.json({ accessToken, refreshToken, user });
});

app.post("/auth/otp/start", (req, res) => {
  res.json({ sent: true, devOtp: "000000" });
});

app.post("/auth/otp/verify", (req, res) => {
  const identifier = req.body?.phone || req.body?.email;
  const user = Object.values(USERS).find((u) => u.phone === identifier || u.email === identifier) || USERS["user@test.wawu.dev"];
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user.sub);
  res.json({ accessToken, refreshToken, user });
});

app.post("/auth/refresh", (req, res) => {
  try {
    const decoded = jwt.verify(req.body.refreshToken, PUBLIC_KEY, { algorithms: ["RS256"] });
    const user = Object.values(USERS).find((u) => u.sub === decoded.sub);
    if (!user) return res.status(401).json({ message: "invalid refresh token" });
    res.json({ accessToken: signAccessToken(user), refreshToken: signRefreshToken(user.sub) });
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

app.get("/health", (_req, res) => res.json({ ok: true, service: "mock-wawu-id" }));

const PORT = process.env.MOCK_WAWU_ID_PORT || 4001;
app.listen(PORT, () => {
  console.log(`[mock-wawu-id] listening on :${PORT}`);
  console.log(`[mock-wawu-id] JWKS: http://localhost:${PORT}/.well-known/jwks.json`);
  console.log(`[mock-wawu-id] seeded users: ${Object.keys(USERS).join(", ")}`);
});
