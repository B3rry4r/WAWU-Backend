#!/usr/bin/env bash
# Proves the local stack works end to end, the way a person would use it:
# a NEW user registers on the local wawu-id, confirms their email with the
# code wawu-id generated, signs in through the real login, and calls the Hub
# with that token. Then a seeded account signs in and sees its seeded data.
# No token is minted here; every token comes from wawu-id's own login.
#
#   scripts/local/up.sh --detach && scripts/local/smoke.sh
#
# Exits 0 only when every step passed. Reads the ports from the two .env
# files that up.sh wrote, and only ever calls localhost.
set -euo pipefail

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ID_DIR="${WAWU_ID_DIR:-$HUB_DIR/../wawu-id}"
ID_LOG="${WAWU_ID_LOG:-$HUB_DIR/.local/logs/wawu-id.log}"

env_get() {
  local line; line="$(grep -E "^$2=" "$1" | tail -n 1 || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; printf '%s' "$line"
}
fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS  %s\n' "$*"; }
# json FILTER: reads JSON on stdin, prints the JS expression FILTER evaluated against it as `j`.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{j=null}const v=(new Function("j","return ("+process.argv[1]+")"))(j);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }

[[ -f "$HUB_DIR/.env" && -f "$ID_DIR/.env" ]] || fail "Run scripts/local/up.sh first (no .env in the hub or wawu-id checkout)."
HUB="http://localhost:$(env_get "$HUB_DIR/.env" HUB_API_PORT)/api/hub"
ID_PORT="$(env_get "$ID_DIR/.env" PORT)"; ID="http://localhost:${ID_PORT:-3000}"
[[ -f "$ID_LOG" ]] || fail "No wawu-id log at $ID_LOG. Start the stack with scripts/local/up.sh, or set WAWU_ID_LOG."

# 1. Both services answer.
code="$(curl -s -o /dev/null -w '%{http_code}' "$ID/health")"
[[ "$code" == 200 ]] || fail "wawu-id $ID/health answered $code"
pass "wawu-id health 200 ($ID/health)"
body="$(curl -s "$HUB/health")"
[[ "$(json 'j.data.ok' <<<"$body")" == true ]] || fail "Hub health: $body"
pass "Hub API health ok ($HUB/health)"

# 2. A new person registers on wawu-id.
stamp="$(date +%s)$RANDOM"
email="smoke-$stamp@example.test"
phone="+23490${stamp: -8}"
password="smoke-pass-$stamp"
body="$(curl -s -X POST "$ID/auth/register" -H 'content-type: application/json' \
  -d "{\"firstName\":\"Smoke\",\"lastName\":\"Test\",\"email\":\"$email\",\"phone\":\"$phone\",\"country\":\"Nigeria\",\"password\":\"$password\"}")"
user_id="$(json 'j.data.user.id' <<<"$body")"
[[ -n "$user_id" ]] || fail "register: $body"
pass "registered $email on wawu-id (id $user_id)"

# 3. Signing in before the email is confirmed is refused, as in production.
body="$(curl -s -X POST "$ID/auth/login" -H 'content-type: application/json' \
  -d "{\"identifier\":\"$email\",\"password\":\"$password\"}")"
[[ "$(json 'j.code' <<<"$body")" == EMAIL_NOT_VERIFIED ]] || fail "login before verifying should be EMAIL_NOT_VERIFIED: $body"
pass "login before confirming the email is refused (EMAIL_NOT_VERIFIED)"

# 4. Ask for the code, read it from the wawu-id log (local mail is not sent), confirm.
curl -s -X POST "$ID/auth/email/verify/start" -H 'content-type: application/json' -d "{\"email\":\"$email\"}" >/dev/null
otp=""
for _ in $(seq 1 20); do
  otp="$(grep -a "to=$email " "$ID_LOG" | grep -oE 'code=[0-9]{6}' | tail -n 1 | cut -d= -f2 || true)"
  [[ -n "$otp" ]] && break
  sleep 0.5
done
[[ -n "$otp" ]] || fail "no verification code for $email in $ID_LOG"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ID/auth/email/verify/confirm" -H 'content-type: application/json' -d "{\"email\":\"$email\",\"code\":\"$otp\"}")"
[[ "$code" == 200 ]] || fail "email confirm answered $code"
pass "email confirmed with the code wawu-id generated"

# 5. Real login, then an authenticated Hub route with that token.
body="$(curl -s -X POST "$ID/auth/login" -H 'content-type: application/json' \
  -d "{\"identifier\":\"$email\",\"password\":\"$password\"}")"
token="$(json 'j.data.accessToken' <<<"$body")"
[[ -n "$token" ]] || fail "login: $body"
pass "signed in through wawu-id /auth/login"

code="$(curl -s -o /dev/null -w '%{http_code}' "$HUB/users/me")"
[[ "$code" == 401 ]] || fail "GET /users/me without a token answered $code, expected 401"
pass "GET $HUB/users/me without a token: 401"
body="$(curl -s "$HUB/users/me" -H "authorization: Bearer $token")"
[[ "$(json 'j.data.wawuUserId' <<<"$body")" == "$user_id" ]] || fail "GET /users/me with the token: $body"
pass "GET $HUB/users/me with the token: 200, wawuUserId $user_id"

# 6. Write something and read it back through the API.
bio="Written by smoke.sh at $stamp"
body="$(curl -s -X PATCH "$HUB/users/me" -H "authorization: Bearer $token" -H 'content-type: application/json' -d "{\"bio\":\"$bio\"}")"
[[ "$(json 'j.statusCode' <<<"$body")" == 200 ]] || fail "PATCH /users/me: $body"
body="$(curl -s "$HUB/users/me" -H "authorization: Bearer $token")"
[[ "$(json 'j.data.bio' <<<"$body")" == "$bio" ]] || fail "bio did not read back: $body"
pass "PATCH /users/me bio, read back the same value"

# 7. A seeded account signs in and sees the data prisma/seed.ts gave it.
seed_pw="${LOCAL_SEED_PASSWORD:-wawu-local-2026}"
body="$(curl -s -X POST "$ID/auth/login" -H 'content-type: application/json' \
  -d "{\"identifier\":\"creator-pro@test.wawu.dev\",\"password\":\"$seed_pw\"}")"
token="$(json 'j.data.accessToken' <<<"$body")"
[[ -n "$token" ]] || fail "seeded login (creator-pro@test.wawu.dev): $body"
body="$(curl -s "$HUB/users/me" -H "authorization: Bearer $token")"
[[ "$(json 'j.data.accountType' <<<"$body")" == creator ]] || fail "seeded creator's /users/me: $body"
pass "seeded creator-pro@test.wawu.dev signs in; Hub says accountType creator, handle $(json 'j.data.handle' <<<"$body")"

echo
echo "All local checks passed."
