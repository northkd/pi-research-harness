---
name: subagent-model-routing
description: Choose authenticated task-appropriate models using evidence, resource limits and explicit escalation rather than hardcoded provider assumptions.
---

# Bounded research model routing

1. Delegation must be authorized by the current user/project instructions. A large task is not independent permission to launch agents.
2. Discover executable roles and authenticated model labels before launch. Do not invent model IDs, infer quality from names, or treat registry cost=0 as free.
3. Choose a task-appropriate sufficient model; preserve fresh-context independence when the task requires it. Use native thinking max only where supported; external CLI reasoning follows its declared contract.
4. On an 8GB host, admit no new child below2GiB available and keep at most3 active child processes; reserve space for bounded nested work when explicitly authorized.
5. Distinguish reasoning/quality failure from transport, tool, package-loader or authentication failure. Infrastructure failure must not trigger a silent provider/CLI/protocol switch.
6. Two targeted same-model correction rounds with retained evidence precede model escalation. An assessor can advise only within existing model/material authorization; record the reason for any change.
7. A changed model catalogue invalidates cached mapping. New model identities do not inherit another model's success history. Community reports are auxiliary dated evidence, not proof.
8. Use native completion notifications, not sleep/poll loops. A dispatched task is not a completed task. Consume raw results and acceptance criteria at dependency barriers.
9. Do not automatically schedule idle paid benchmarks or send private papers/prompts to new providers. Such tasks require a reliable idle signal, explicit authorization and budget.

Set actual model refs in local role/config files after `/model` and authentication checks. This release deliberately does not ship the maintainer's subscription pools, provider credentials or real evaluation history.
