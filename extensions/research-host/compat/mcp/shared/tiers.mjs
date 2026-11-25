const TIERS = ["observe", "control", "operate"];
function isTier(value) {
  return typeof value === "string" && TIERS.includes(value);
}
function rank(tier) {
  return TIERS.indexOf(tier);
}
function minTier(a, b) {
  return rank(a) <= rank(b) ? a : b;
}
function defaultTierForSource(source) {
  return source === "pairing" ? "operate" : "observe";
}
export {
  TIERS,
  defaultTierForSource,
  isTier,
  minTier,
  rank
};
