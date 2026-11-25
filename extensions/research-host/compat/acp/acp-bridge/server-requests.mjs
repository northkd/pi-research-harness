const NOT_SUPPORTED = "not supported for ACP sessions";
function handleServerMessage(m, ctx) {
  switch (m.type) {
    // ── supported ───────────────────────────────────────────────
    case "send_prompt":
      return ctx.sendPrompt(m);
    case "abort":
      return ctx.abort();
    case "set_model":
      return ctx.setModel(m.provider, m.modelId);
    case "set_thinking_level":
      return ctx.setThinkingLevel(m.level);
    case "prompt_response":
      return ctx.promptResponse(m);
    case "clear_followup_entries":
      return ctx.clearFollowups(m.indices);
    case "edit_followup_entry":
      return ctx.editFollowup(m.index, m.text);
    case "remove_followup_entry":
      return ctx.removeFollowup(m.index);
    case "promote_followup_entry":
      return ctx.promoteFollowup(m.index);
    case "request_state_sync":
      return ctx.resyncState();
    case "request_models":
      return ctx.publishModels();
    case "request_commands":
      return ctx.publishCommands();
    case "prompt_resync_request":
      return ctx.resyncPrompts(m.requestId);
    case "shutdown":
      return ctx.stop("shutdown requested by dashboard", 0);
    case "register_rejected":
      return ctx.stop(`registration rejected: ${m.reason}`, 1);
    // ── reply expected → deterministic empty / refused reply ────
    case "transcript_request":
      return ctx.send({
        type: "transcript_chunk",
        sessionId: ctx.sessionId,
        entries: [],
        complete: true,
        restarted: false,
        refused: { cause: "acp", reason: NOT_SUPPORTED }
      });
    case "list_files":
      return ctx.send({ type: "files_list", sessionId: ctx.sessionId, query: m.query, files: [] });
    case "request_providers":
      return ctx.send({ type: "providers_list", sessionId: ctx.sessionId, providers: [] });
    case "git_commit_draft":
      return ctx.send({ type: "git_commit_draft_result", sessionId: ctx.sessionId, requestId: m.requestId, message: "", source: "stub" });
    // ── pi-only / transport housekeeping: ignored (counted) ─────
    case "provisional_accepted":
    case "session_move_committed":
    case "provisional_rejected":
    case "auto_name_state_restore":
    case "retry_session":
    case "extension_ui_response":
    case "rename_session":
    case "list_sessions":
    case "stop_after_turn":
    case "git_info_refresh":
    case "flow_control":
    case "heartbeat_ack":
    case "path_grant_result":
    case "path_yolo_result":
    case "dashboard_identity":
    case "request_flows_refresh":
    case "credentials_updated":
    case "mcp_token_minted":
    case "plugin_reply":
    case "flow_management":
    case "architect_prompt_response":
    case "role_set":
    case "role_preset_load":
    case "role_preset_save":
    case "role_preset_delete":
    case "role_remove":
    case "request_roles":
    case "ui_management":
    case "kill_process":
    case "server_restarting":
    case "attach_proposal_changed":
    case "plugin_emit_event":
    case "preferences_update":
    case "subagent_resync_request":
    case "vault_snapshot":
    case "thinking_translation_settings_changed":
      return ctx.ignored(m.type);
    default: {
      const unhandled = m;
      return ctx.ignored(String(unhandled.type));
    }
  }
}
export {
  handleServerMessage
};
