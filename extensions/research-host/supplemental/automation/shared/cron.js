function parseField(raw, min, max) {
  const out = /* @__PURE__ */ new Set();
  for (const part of raw.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.split("/");
    if (slash.length === 2) {
      range = slash[0];
      step = Number(slash[1]);
      if (!Number.isInteger(step) || step <= 0) return null;
    } else if (slash.length > 2) {
      return null;
    }
    let lo;
    let hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = hi = Number(range);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  let dow = parseField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) {
    dow = new Set(dow);
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*"
  };
}
function matches(f, d) {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}
function nextFire(expr, after) {
  const f = parseCron(expr);
  if (!f) return null;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const horizon = d.getTime() + 4 * 366 * 24 * 60 * 60 * 1e3;
  while (d.getTime() <= horizon) {
    if (matches(f, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
function isValidCron(expr) {
  return parseCron(expr) !== null;
}
export {
  isValidCron,
  nextFire,
  parseCron
};
