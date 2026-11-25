class ForgeUnavailable extends Error {
  reason;
  constructor(reason) {
    super(reason);
    this.name = "ForgeUnavailable";
    this.reason = reason;
  }
}
class ForgeRateLimited extends Error {
  retryAt;
  rate;
  constructor(retryAt, rate = null) {
    super("forge rate limited");
    this.name = "ForgeRateLimited";
    this.retryAt = retryAt;
    this.rate = rate;
  }
}
const PAGE_SIZE = 100;
export {
  ForgeRateLimited,
  ForgeUnavailable,
  PAGE_SIZE
};
