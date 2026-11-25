function hostHasGitAndShell(which) {
  return which("git") !== null && which("bash") !== null;
}
function selectGitSource(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return "host";
  const setting = opts.setting ?? "auto";
  if (setting === "bundled") return "bundled";
  const which = opts.which ?? (() => null);
  if (setting === "host") {
    return hostHasGitAndShell(which) ? "host" : "bundled";
  }
  return hostHasGitAndShell(which) ? "host" : "bundled";
}
export {
  selectGitSource
};
