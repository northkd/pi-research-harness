const REDACTION_VERSION = 1;
const REDACTION_PLACEHOLDER = "[REDACTED]";
const REDACTION_PATTERNS_V1 = [
  // PEM / PGP private keys; an unclosed or truncated block runs to end of input.
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+[^\s"',}]+/gi,
  /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  // key=value / "key":"value" — optional quotes around key and value.
  /(?<![A-Za-z0-9])(?:(?:api|access|secret)[_-]?key|(?:aws[_-]?)?secret[_-]?access[_-]?key|client[_-]?secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"',}]+/gi,
  // env-style names: MY_API_KEY=, STRIPE_SECRET_KEY=, DB_PASSWORD=, PGPASSWORD=.
  /(?<![A-Za-z0-9_])[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY)\s*=\s*\S+/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  // Provider token formats.
  /(?<![\w-])eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}/g,
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g,
  // Credentials in URLs (keeps scheme/user/host) and secret query parameters.
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
  /([?&](?:(?:access_|refresh_|id_)?token|key|sig)=)[^&\s]+/gi
];
function redactSecrets(text) {
  let out = text;
  for (const re of REDACTION_PATTERNS_V1) {
    out = out.replace(re, (_match, keep) => typeof keep === "string" ? keep + REDACTION_PLACEHOLDER : REDACTION_PLACEHOLDER);
  }
  return out;
}
export {
  REDACTION_PATTERNS_V1,
  REDACTION_PLACEHOLDER,
  REDACTION_VERSION,
  redactSecrets
};
