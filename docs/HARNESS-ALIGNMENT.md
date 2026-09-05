# Harness alignment

Agent Manager coordinates ownership, worktrees, verification and delivery.
Workers own investigation, implementation steps, native tools and conversation
management. Start with one cohesive lane; split only independent outcomes or
distinct ownership. A frozen assignment preserves authority and acceptance
criteria, not an immutable implementation plan. Workers may consult permitted
read-only sources; the manager owns planning-system updates.

## Explicit settings, intentional inheritance

Optional settings merge by harness, with lane values taking precedence:

```yaml
harness_default: codex
model_default: gpt-6-astra
harness_defaults:
  codex:
    effort: high
    profile: coding
  claude:
    effort: high
lanes:
  - id: implementation
    scope: src/**
    prompt: Complete the assigned behavior and required verification.
    harness_options:
      effort: medium
```

This is a fragment; normal repository, planning and delivery fields still apply.
Codex profiles must already exist in the installed harness. `profile` is a simple
name, not a path. It is passed before `exec resume`; effort uses the harness's
`model_reasoning_effort` configuration. Claude receives `--effort` and an explicit
lane effort overrides inherited `CLAUDE_CODE_EFFORT_LEVEL`. Without an explicit
choice, user settings and the filtered effort environment remain in effect.

Effort levels are model-specific, not interchangeable cost budgets. Claude
accepts low, medium, high, xhigh and max. Codex additionally accepts legacy none
and minimal values, but those are rejected for an explicitly selected Astra.
Unknown future model compatibility remains the harness's responsibility.
Cursor rejects these options rather than silently ignoring them. Preflight checks
that the installed CLI advertises requested option flags; it cannot certify
account access, profile contents or the effective model's effort support.

Run telemetry records harness version checks and each lane's `harnessOptions`.
`effortObserved` is populated only from an explicit structured harness field.
Requested or inherited settings are never labeled verified. Report output shows
both requested and observed effort. Profiles can affect other native settings;
Agent Manager continues to pass the workflow's sandbox policy explicitly.

## Quiet work and runtime limits

```yaml
policy:
  stall_timeout_sec: 600
  stall_grace_sec: 600
  max_runtime_sec: 7200
```

After ten minutes without bytes, telemetry changes to `quiet`. It does not claim
the model is stalled or progressing. Another ten quiet minutes expire the lane.
New output ends the quiet period. The example opts into a two-hour wall-clock
deadline to bound noisy processes; no wall-clock deadline is imposed when omitted.
Limits apply per launch/resume attempt, not to the entire run. Set an appropriate
deadline for the task. `stall_grace_sec: 0` restores immediate cancellation at the
silence threshold. The default ten-minute grace changes existing workflow timing.

Timeout reasons survive process shutdown in `supervision.reason`; a new attempt
starts fresh. This is deliberately a transport-based fallback. Structured tool
events and native steering need a version-tested adapter before they replace it.
Corrections still interrupt and resume the current CLI session; they are not
advertised as non-interrupting native steering.

## Bounded review

Existing workflows retain one correction and a final second review. A manager
may include a larger budget only when that scope is explicitly authorized:

```yaml
delivery:
  review_budget:
    max_corrections: 2
    max_elapsed_sec: 3600
```

The count supports zero through five corrections. The elapsed window begins at
the first correction decision. After count or time exhaustion, review may still
accept, accept with notes, or reject; it cannot authorize another correction.
Each correction requires a recorded decision, and subsequent corrections require
notes describing observed progress and remaining gaps. The manager verifies that
progress from the diff and tests; text notes alone are not proof of improvement.
Repeated lack of progress is an escalation, not a reason to spend the full limit.

The budget is frozen in run delivery telemetry. It supplies no autonomous
acceptance, scope expansion, shipping grant, or permission bypass. Existing
conditional authorization checks and Ship Gate still apply. Director policies
retain their own narrower correction limit.

## Diagnostics and cost estimates

Doctor reports invalid JSON and unreadable caches, but a missing historical
Codex cache field is `schema-unverified`, not proof that repair is needed.
Consult the installed CLI diagnostics before changing its cache.

Pricing contains specific Astra, GPT-5.6 and Fable 5.1 entries verified September
5, 2026. Fable 5.1 cache reads use $0.25 per million tokens. Astra includes cache
writes and the over-272K context multiplier. Estimates assume Standard API rates,
not subscription invoices, regional uplifts, or Fast/Batch/Flex discounts. Other
legacy family estimates remain approximate. Unknown GPT variants return no price
instead of inheriting the original GPT-5 rate. Custom pricing files take priority.

## Native adapter evaluation

Keep native conversation history and compaction inside Codex/Claude Code.
Do not implement another reasoning loop or rewrite saved model history here.
Native subagents share the lane's authority, file ownership and delivery contract;
do not silently enable unbounded nested orchestration.

Before replacing CLI interrupt/resume or enabling native workflow orchestration,
compare these three modes on the same immutable task/base and model effort:

1. Existing multi-lane workflow with legacy grace settings.
2. One cohesive Agent Manager lane with this outcome-based contract.
3. Native harness orchestration in an isolated evaluation workspace.

Use a scoped bug fix, coupled feature, independent migration, and interrupted
long task. Repeat each case; record accepted-result quality, total elapsed time,
input/output/cache usage, human interventions, unnecessary changes, and recovery.
Include quiet reasoning, slow tools, permission denial, provider errors, and a
correction during an active command. Do not promote an adapter until it preserves
scope and cancellation semantics, approval delivery, history and artifact evidence.
No live-model superiority claim follows from unit tests or fake-harness runs.

Sources:
- [Astra model and prompting](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code workflows](https://code.claude.com/docs/en/workflows)
- [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview)
