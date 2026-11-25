const RES_WORKFLOW_MAX_HISTORY_SELECTION = 40;
function isResWorkflowServiceSession(session) {
  return session.pluginHidden === true || session.archiveOnEnd === true;
}
export {
  RES_WORKFLOW_MAX_HISTORY_SELECTION,
  isResWorkflowServiceSession
};
