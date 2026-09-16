// TOTP (RFC 6238, on top of HOTP/RFC 4226) implemented by hand with node's
// built-in `crypto` - no otplib/speakeasy dependency. This app keeps a
// deliberately light dependency footprint (bcryptjs, express, ...), and
// TOTP is a small, fully-specified algorithm: HMAC-SHA1 over a 30-second
// time counter, dynamically truncated to a 6-digit code. Worth writing once
// and testing against the RFC's own vectors (see test/totp.test.js) rather
// than pulling in a package for it.
const crypto = require("crypto");

const STEP_SECONDS = 30;
const DIGITS = 6;
// How many 30s steps of clock drift, either direction, a submitted code is
// still accepted for - 1 step = accept the previous/current/next code, i.e.
// up to ~59s of drift between the server and whatever generated the code
// (an authenticator app, which has the same tolerance baked into every
// other TOTP-checking service). Kept small deliberately: every extra step
// is one more valid code at any given moment, which is exactly what an
// attacker guessing codes benefits from.
const WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Encodes a Buffer as unpadded base32 (RFC 4648 ¤6) - the conventional
// format for a TOTP secret shown to a human / put in an otpauth:// URI.
// Unpadded because that's what every authenticator app expects to paste in;
// padding characters ('=') are optional in the RFC and just extra noise here.
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

// Decodes base32 back to a Buffer. Tolerant of lowercase, stray whitespace,
// and '=' padding - all things a human might introduce copy-pasting a
// secret around, none of which should turn into a hard failure here.
function base32Decode(str) {
  const cleaned = String(str || "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Generates a new random secret, returned already base32-encoded - the
// form it's stored in (agents.totp_secret) and shown to the agent for
// manual entry. 20 raw bytes (160 bits) is the size RFC 4226 itself
// recommends for the HMAC-SHA1 key.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// RFC 4226's HOTP: HMAC-SHA1 over an 8-byte big-endian counter, then
// "dynamic truncation" - take 4 bytes starting at an offset picked from the
// hash's own last nibble, mask off the sign bit, and reduce mod 10^digits.
function hotp(secretBuffer, counter, digits = DIGITS) {
  const counterBuffer = Buffer.alloc(8);
  // Buffer has no writeUInt64BE; counters here are tiny (seconds-since-epoch
  // divided by 30 - won't hit 2^32 until the year 6429) so the low 32 bits
  // are all that's ever set, high 4 bytes stay zero.
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter % 2 ** 32, 4);

  const hmac = crypto.createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = binCode % 10 ** digits;
  return String(code).padStart(digits, "0");
}

function counterForTime(time) {
  return Math.floor(time / 1000 / STEP_SECONDS);
}

// The current 6-digit code for a base32 secret - used by setup/verify flows
// and by the tests (RFC 6238's own vectors, decoded through this same
// base32 round-trip) to check the implementation end to end.
function generateToken(base32Secret, { time = Date.now(), digits = DIGITS } = {}) {
  return hotp(base32Decode(base32Secret), counterForTime(time), digits);
}

// Constant-time-ish comparison of two equal-length digit strings - avoids a
// short-circuiting === from leaking (via timing) how many leading digits of
// a guess were correct. Both inputs are normalized to a fixed length first
// since crypto.timingSafeEqual requires matching buffer lengths.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Verifies a submitted code against a base32 secret, tolerating up to
// WINDOW_STEPS of clock drift either side of "now". Returns a boolean -
// callers don't need to know which offset matched, only whether the code
// was valid at all.
function verifyToken(base32Secret, token, { time = Date.now(), window = WINDOW_STEPS } = {}) {
  const normalized = String(token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;

  const secretBuffer = base32Decode(base32Secret);
  const counter = counterForTime(time);
  for (let offset = -window; offset <= window; offset++) {
    const candidate = hotp(secretBuffer, counter + offset);
    if (safeEqual(candidate, normalized)) return true;
  }
  return false;
}

// The otpauth:// URI an authenticator app can import via manual entry (this
// app shows the secret + this URI as text rather than rendering a QR code -
// see the account-security feature notes for why: no QR-generation
// dependency, and a hand-rolled QR renderer would be more code/risk than
// it's worth for what manual entry already covers just fine).
function buildOtpauthUri(base32Secret, { issuer = "Velv Ticketing", label }) {
  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${encodedLabel}?${params.toString()}`;
}

module.exports = {
  STEP_SECONDS,
  DIGITS,
  generateSecret,
  generateToken,
  verifyToken,
  buildOtpauthUri,
  base32Encode,
  base32Decode,
  hotp,
};
