const BEIJING_OFFSET = 8 * 60 * 60 * 1e3;
function billingPeriod(month, now = Date.now()) {
  const selected = month ?? new Date(now + BEIJING_OFFSET).toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected))
    throw new Error("Invalid billing month");
  const start = /* @__PURE__ */ new Date(`${selected}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return {
    month: selected,
    timeZone: "Asia/Shanghai",
    startTime: start.getTime() - BEIJING_OFFSET,
    endTime: end.getTime() - BEIJING_OFFSET
  };
}
function inBillingPeriod(timestamp, period) {
  return timestamp >= period.startTime && timestamp < period.endTime;
}
export {
  billingPeriod,
  inBillingPeriod
};
