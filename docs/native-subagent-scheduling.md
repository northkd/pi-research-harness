# Native Subagent live admission

The collaboration settings govern two different execution paths: native
`research_session` / `research_dispatch` collaborators and the installed
`pi-subagents` plugin. Updating only the dispatcher does not constrain native
plugin children.

The authenticated `pi-subagents@0.79.2` patches call
`createResearchScheduledChild` from both foreground `execution.js` and detached
`run-child-session.js`, immediately before their actual child factory. With the
portable Dashboard's `PI_RESEARCH_LOOP_ROOT`, that adapter calls the installed
`research-loop/src/subagent-scheduling.mjs`. Ordinary installations without that
host setting keep upstream behavior. A configured but missing or unavailable
bridge fails closed instead of silently launching outside the limit.

## Contract

- The host supplies the parent session ID, native run ID and child index; the
  model does not choose its owner, parent identity, endpoint or credentials.
- Admission uses the existing loopback Dashboard authentication and
  `/api/res-workflow/collaboration/native`. Tokens never enter tool arguments,
  model context, UI state or diagnostics.
- The server persistently records a request before launch. Only an acquired
  slot permits native `AgentSession` creation. Waiting requests poll admission
  once per second; they do not cache the concurrency setting or call a model.
- Increasing the cap admits eligible waiting requests on their next poll.
  Decreasing it leaves already admitted children running and postpones new
  admission until the active count falls below the new limit. Any explicitly
  narrower native workflow/step concurrency setting continues to apply.
- A stable parent/run/index request ID plus a unique host attempt ID distinguish
  HTTP retries from another process trying to launch the same work. A new
  attempt can follow a confirmed release; it cannot reuse an unconfirmed active
  attempt's capacity.
- A final `launching` check verifies current tenure/membership before the
  factory call. Running children retain their slot after main-agent replacement
  or detachment; those actions do not silently kill the child. Their queued
  siblings cannot start under the former authority.
- Only confirmed child disposal releases active capacity. A lost or failed
  disposal, invalid factory result or unknown remote launch keeps its lease for
  explicit recovery. A heartbeat is evidence of contact, never a timed lease
  that frees capacity while work might still be running.
- Cancellation before launch removes the queued request. If admission succeeded
  but its response was lost, cleanup recovers the same attempt's lease before
  releasing it. It never creates a substitute launch.
- A server-confirmed never-joined session may continue unmanaged native work.
  A removed or historical participant must never receive that fallback.

The cap counts active child executions, not all operating-system processes.
A native background orchestration runner can already exist while its actual
model child is waiting for admission. No claim is made that queued background
tasks consume zero memory or that the setting is a host-wide OS process limit.

## Installation and verification

`scripts/apply-subagents-v020.mjs` authenticates all patched files and supports
fresh `0.79.2`, the previous skill-context release, the model-selection release,
and the earlier budget-bridge release. Mixed or modified package states are
rejected. The existing model identity protection and selected-skill filtering
are preserved. Deploying these new code paths requires the normal one-time
runtime restart; subsequent concurrency edits do not require restarting agents.

`node --test tests/native-subagent-scheduling.test.mjs` exercises the bridge with
fake owned sessions and a deterministic admission server. It covers live limit
changes, pending cancellation, detach races, lost responses, idempotent release,
unknown outcomes and unchanged non-research behavior. These tests call no paid
model and do not establish scientific task completion.

`node --test tests/native-subagent-collaboration.test.mjs` also connects this
adapter to the actual collaboration service through a fake HTTP transport. It
verifies persisted slot ownership across service restart, independent parent
caps, drag-reordered next dispatch, real limit mutations, historical/removed
parents, and refusal to duplicate an unconfirmed native attempt. The child
factory remains a test double: no model is contacted.
