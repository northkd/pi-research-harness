import { startFlowFilesReporter } from "./flow-files-reporter.js";
import { FlowQuestionAdapter } from "./flow-question-adapter.js";
function activate(ctx) {
  const c = ctx;
  const pi = c?.pi ?? c;
  const events = pi?.events;
  if (!events || typeof events.emit !== "function") return;
  events.emit("prompt:register-adapter", new FlowQuestionAdapter());
  startFlowFilesReporter(pi);
}
export {
  activate as default
};
