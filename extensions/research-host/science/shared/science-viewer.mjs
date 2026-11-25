function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function shape(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function taskId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
function isScienceViewTarget(value) {
  return object(value) && (value.kind === "workspace" && shape(value, ["kind"]) || value.kind === "task" && shape(value, ["kind", "taskId"]) && taskId(value.taskId));
}
function scienceTabPath(target) {
  if (!isScienceViewTarget(target)) throw new Error("invalid-science-target");
  return target.kind === "workspace" ? "science:workspace" : `science:task:${target.taskId}`;
}
function parseScienceTabPath(value) {
  if (typeof value !== "string") return null;
  if (value === "science:workspace") return { kind: "workspace" };
  const id = value.startsWith("science:task:") ? value.slice("science:task:".length) : void 0;
  return taskId(id) ? { kind: "task", taskId: id } : null;
}
const finite = (value, low, high) => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const optionalEnum = (value, values) => value === void 0 || typeof value === "string" && values.includes(value);
const text = (value, max) => value === void 0 || typeof value === "string" && value.length <= max && !value.includes("\0");
function isScienceViewInput(value) {
  if (!object(value)) return false;
  switch (value.kind) {
    case "mouse":
      return shape(value, ["kind", "x", "y", "action", "button", "clickCount"]) && finite(value.x, 0, 1) && finite(value.y, 0, 1) && optionalEnum(value.action, ["click", "move", "down", "up"]) && optionalEnum(value.button, ["left", "middle", "right"]) && (value.clickCount === void 0 || Number.isInteger(value.clickCount) && finite(value.clickCount, 1, 3));
    case "scroll":
      return shape(value, ["kind", "x", "y", "deltaX", "deltaY"]) && finite(value.x, 0, 1) && finite(value.y, 0, 1) && (value.deltaX === void 0 || finite(value.deltaX, -1e4, 1e4)) && (value.deltaY === void 0 || finite(value.deltaY, -1e4, 1e4));
    case "key":
      return shape(value, ["kind", "keyType", "key", "code", "text"]) && optionalEnum(value.keyType, ["keyDown", "keyUp", "char"]) && text(value.key, 128) && text(value.code, 128) && text(value.text, 4096);
    case "resize":
      return shape(value, ["kind", "width", "height"]) && Number.isInteger(value.width) && Number.isInteger(value.height) && finite(value.width, 1, 3840) && finite(value.height, 1, 2160);
    case "bringToFront":
      return shape(value, ["kind"]);
    default:
      return false;
  }
}
export {
  isScienceViewInput,
  isScienceViewTarget,
  parseScienceTabPath,
  scienceTabPath
};
