---
description: Plan → implement → polish → ship a task end-to-end (autonomous, multi-repo), reporting progress between phases. Drains an ordered queue when given "queue"; "enqueue <plan|description>" adds to the queue without executing.
argument-hint: [plan-file path | task description | "queue" | "enqueue <plan|description>"]
allowed-tools: Bash(echo:*)
---

**Packaging note (plugin).** This command ships in the `forge` plugin and invokes its workflow engine **by path, not by name**. Resolve the engine's absolute path once, here:

!`echo "${CLAUDE_PLUGIN_ROOT}/workflow/forge.js"`

Refer to that resolved absolute path as **`FORGE_WF`**. Every `Workflow(...)` instruction below uses `scriptPath: FORGE_WF` — substitute the path printed just above. **Never** call `Workflow({ name: 'forge', ... })`: this plugin's workflow is not installed on the named workflow search path, so name-based resolution would fail.

You are driving the **forge** pipeline as a chain of three background workflows (`plan` → `build` → `ship`), reporting high-level progress in THIS chat between each phase so the user doesn't have to open the `/workflows` UI. This is **fully autonomous** — the user has authorized push and deploy without a confirmation gate.

## 0. Mode select

Look at `$ARGUMENTS`:

- **first token is `enqueue`** (i.e. `/forge enqueue <plan-path | task description>`) → **ENQUEUE MODE** (§E below). Add a plan to the queue and STOP — never execute. Checked first so it can never fall through to an executing mode.
- **`queue`** (the literal word), **or empty when `<cwd>/.forge/queue.json` exists** → **DRAIN MODE** (§Q below). Drain an ordered, durable queue of plans, one at a time.
- **a plan-file path, a task description, or empty when NO `.forge/queue.json` exists** → **SINGLE-PLAN MODE** (§1–§3 below). Unchanged from the original behavior.

---

# SINGLE-PLAN MODE

## 1. Resolve the input

`$ARGUMENTS` is either a path to an existing plan file, or a free-text task description.

- **If it's a path to an existing file** → that is the plan. Set `planPath` to it.
- **If it's a task description (or empty)** → write a short draft plan first. Derive a kebab-case slug and write the draft to `<workspaceRoot>/.forge/tasks/<slug>.md` (create `.forge/tasks/` if needed). The draft just needs the goal, likely repos/files, and open questions — Phase 1 refines it.

Determine `workspaceRoot` (the current working directory unless the task clearly scopes to one repo).

## 2. Run the three phases in sequence, reporting between each

Each call returns when that phase finishes; relay a one-line update in this chat, then start the next.

**Phase 1 — plan:**
```
Workflow({ scriptPath: FORGE_WF, args: { phase: 'plan', planPath, workspaceRoot } })
```
On return, post e.g.: `📋 Plan: converged in {planRounds} round(s){, or note if it hit the cap / aborted}. Starting build.`

**Then validate the generated checklist before build:**
```
cd <workspaceRoot>/.forge/codex && PYTHONPATH=. python3 -m forge_codex.cli \
  checklist-advise <workspaceRoot>/.forge/tasks/<slug>.checklist.md --execute --json
```
Review both `advisories` and executable `findings`. Fix structural findings and
any failing precondition that exposes a genuinely missing capability; an
acceptance check that fails because the work is not yet implemented is expected.
Do not invent content to silence a finding, and do not author whole-file exact
grep occurrence counts as dependency checks. Prefer behavioral, AST/schema-aware,
or declaration-scoped checks.

**Phase 2 — build:** thread the plan phase's `scenarios` array through so the detector doesn't re-run:
```
Workflow({ scriptPath: FORGE_WF, args: { phase: 'build', planPath, workspaceRoot, scenarios: <plan result .scenarios> } })
```
On return, post e.g.: `🔨 Build: {checklistItems} items across {repos.length} repo(s), tests {green/failing}. Polishing + shipping.`
If it returns `status: 'no-op'` (empty checklist), report that and STOP — nothing to ship.

**Phase 3 — ship:** pass the build phase's `implemented` array straight through, plus its `scenarios` (so the code-refine specialists activate without a re-detect):
```
Workflow({ scriptPath: FORGE_WF, args: { phase: 'ship', workspaceRoot, implemented: <build result .implemented>, scenarios: <build result .scenarios> } })
```
On return, give the final summary (below).

## 3. Final summary — keep it BRIEF

Aggregate across the three phase returns, in this order:

1. **Did anything go sideways?** Concatenate the `warnings` arrays from all three phases. If any exist, lead with them. If none, say "Clean run, nothing went sideways."
2. **Rounds actually executed:** `planRounds` (and whether it converged or hit the cap) from phase 1, and the per-repo code-refine rounds from phase 3's `codeRoundsByRepo`.
3. One line on what shipped (repos + deploy method) from phase 3's `shipped`.

Then send a single `PushNotification` for the walk-away case — succinct: what shipped, or the headline of what went sideways. (Only one, at the very end.)

Don't dump the full result objects — the summary should be a few lines.

## Notes
- `phase: 'all'` exists on the workflow to run the entire pipeline in one background run without inter-phase reporting — use it only if the user explicitly asks for a single fire-and-forget run.
- The plan file on disk is the hand-off between phase 1 and 2; the `implemented` array is the hand-off between phase 2 and 3.

---

# ENQUEUE MODE (§E)

`/forge enqueue <plan-path | task description>` — add a plan to the queue **without executing anything**. This is the safe way to add work while a `/forge queue` drain is live (or before one starts). This mode **NEVER launches a phase, NEVER enters drain, and NEVER schedules a heartbeat** — it appends one item and stops.

## E1. Resolve the plan into `.forge/tasks/`

Strip the leading `enqueue` token; the rest is the input. Determine `workspaceRoot` (the `workspaceRoot` field in an existing `.forge/queue.json`, else cwd).

- **Input is a path to an existing file** → that is the plan. Set `planPath` (relative to `workspaceRoot` if it lives under it, else absolute).
- **Input is a task description** → derive a kebab-case `slug`, write a short draft (goal, likely repos/files, open questions) to `<workspaceRoot>/.forge/tasks/<slug>.md` (create the dir if needed). Phase 1 refines it when the item later runs.

## E2. Append a pending item (atomic, append-only)

- Choose a unique stable `id` = the topic slug (e.g. `worker-telemetry`). **No `NNNN-` number prefix** for `.forge/tasks/` plans: numbers are required nowhere (the queue orders by array position + `dependsOn`, not by number), and topic slugs avoid the cross-session collisions sequential numbers cause. (The legacy `forge-api/plans/tasks/` tree keeps its numbers — they're cross-referenced there; this slug-only rule is for `.forge/tasks/`.) If a slug somehow collides with an existing id, suffix `-2`, `-3`, …
- If `<workspaceRoot>/.forge/queue.json` does NOT exist, create it: `{"version":1,"workspaceRoot":"<abs>","items":[]}`.
- While drafting the plan, explicitly classify the task by its own nature; the runtime must never infer a class from task prose:
  - `mechanical` — clearly repeatable, low-judgment, self-contained, cheap-to-redo work such as asset/logo generation, importing an already-verified and spot-checked corpus, or credential-rotation scripts.
  - `routine` — ordinary, well-specified feature work following a documented pattern, such as scaffolding a thin consumer of an existing shared kit.
  - Otherwise omit the class and retain the safe `critical` default. Always do this when unsure and for security, credentials, access control, novel architecture, cross-cutting refactors, generated customer-facing or legal prose, and algorithmic correctness.
- **Primary path:** when `<workspaceRoot>/.forge/codex/forge_codex/cli.py` exists, use the real locked, journaled verb:
  ```sh
  cd <workspaceRoot>/.forge/codex && PYTHONPATH=. python3 -m forge_codex.cli \
    enqueue <id> <planPath> --workspace <workspaceRoot> \
    [--depends-on <dep> ...] [--execution-class routine|mechanical]
  ```
  Keep `--workspace` after the subcommand. Omit `--execution-class` for `critical`. The verb takes the queue lock, journals `queue.item.enqueued`, refuses duplicate ids, and writes `executionClass` natively. If it exits 2 with `queue item already exists`, apply the existing `-2`, `-3`, … suffix rule and retry with the new id. Do not use the `cp`/`jq`/`mv` path in a workspace with this checkout.
- **Fallback path for generic workspaces only:** when `.forge/queue.json` exists but there is no `.forge/codex` checkout, **re-read the file fresh**, `cp -f queue.json queue.json.bak`, then append with `jq` to a temp file + `mv -f` (the §Q7 discipline). The new item:
  ```json
  { "id":"<id>", "planPath":"<path>", "status":"pending", "attempts":0,
    "maxAttempts":2, "dependsOn":[], "phaseReached":null, "taskId":null,
    "result":{}, "failure":null, "executionClass":<chosen value or null> }
  ```
  A `null` fallback value uses the safe legacy `critical` route. **Only append.** Never touch any existing item's `status`/`phaseReached`/`taskId` — those belong to the drain driver (§Q1). After writing, **read back and confirm the pre-existing items are byte-identical** (clobber check); if they changed, restore from `.bak` and retry the append once.
- `dependsOn` defaults to `[]` (independent — a failure elsewhere won't block it). Set prerequisites only if the user names them (must be existing ids).

## E3. STOP — do not execute

- **Check whether a drain is live:** is any item in `queue.json` currently `status:"running"`?
- **Report accordingly:**
  - **No item is `running`** (nothing is draining — this includes adding the FIRST plan / a freshly-created queue, and a queue that previously drained and stopped) → emit a clear reminder, because processing will **not** start on its own:
    `➕ enqueued <id> → <planPath> (queue: N pending). ⚠️ Nothing is draining right now — run \`/forge queue\` to start processing, or it will just sit in the queue.`
  - **An item IS `running`** (a drain is live) → `➕ enqueued <id> → <planPath> (queue: N pending). A live drain will pick it up at its next dispatch — no action needed.`
- Do **NOT** launch any `Workflow`, enter DRAIN MODE, or call `ScheduleWakeup`. The command ends here.

---

# DRAIN MODE (§Q)

Drain `<workspaceRoot>/.forge/queue.json`: an ordered list of plans, each run through the **same** three forge phases with the **same** per-phase reporting as single-plan mode. The queue is durable (survives re-invocation); state lives in the file, not in your head. `workspaceRoot` = the `workspaceRoot` field in the file (fall back to cwd).

**This command runs ONCE per invocation.** You are re-invoked automatically when a phase Workflow completes (a `<task-notification>`), or by the stall heartbeat (§Q5). Each invocation: reconcile → dispatch ONE action → persist → either schedule the next wake or finish. Do not loop in-process waiting for a phase; launch it and let the completion notification re-invoke you.

## Q1. State model — `.forge/queue.json`

```jsonc
{
  "version": 1,
  "workspaceRoot": "/abs/path/to/workspace",
  "items": [
    {
      "id": "0211-worktree-gc",                 // unique, stable
      "planPath": "forge-api/plans/tasks/0211-forge-next-worktree-gc.md",  // abs, or relative to workspaceRoot
      "status": "pending",       // pending | running | done | failed | blocked | skipped
      "attempts": 0, "maxAttempts": 2,
      "dependsOn": [],           // ids that must be "done" before this item is runnable
      "phaseReached": null,      // null | plan | build | ship  (the last phase LAUNCHED for this item)
      "taskId": null,            // current phase's Workflow task id (for the §Q5 liveness check)
      "result": {},              // accumulates: planRounds, planConverged, checklistItems, repos,
                                 //   implemented, shipped, codeRoundsByRepo, warnings:[]
      "failure": null            // { phase, reason } when status=failed
    }
  ]
}
```

**Write discipline (critical):**
- **Re-read the file immediately before every mutation** — never write from a stale copy. Another invocation or the user may have appended items.
- **Write atomically:** mutate with `jq` to a temp file, then `mv -f` over the original (see §Q7). Keep the previous content as `.forge/queue.json.bak` before overwriting.
- **You are the SOLE writer of status fields.** Users only *append new items* (status `pending`). Never resurrect an item the user removed.

## Q2. On every invocation — reconcile, then dispatch EXACTLY ONE action

**Read `.forge/queue.json` fresh first.** Then walk this decision tree top-to-bottom and take the **first** branch that applies. Each branch ends by either launching exactly one phase (then STOP and await the notification) or finishing the queue. Never launch two phases in one invocation.

**A. Was this invocation triggered by a `<task-notification>` whose `<task-id>` matches a `running` item's `taskId`?**
   → That item's `phaseReached` just finished. Apply §Q3 for that phase: record its result, then EITHER launch the item's next phase (STOP), OR mark the item `done`/`failed` and fall through to branch **D** to pick the next item. Do not also evaluate branch B/C for this invocation.

**B. Else, is some item `running` with a `taskId`?** (A heartbeat or stray wake — no matching completion.)
   → **Liveness check:** `TaskOutput({ task_id, block: false })` on that item.
   - **completed** → you missed the notification; treat exactly as branch **A** (fold its result via §Q3).
   - **still running** → re-arm the heartbeat (§Q5) and **STOP**. (Optionally post a brief "still on [id]/[phase]".)
   - **failed / gone** → the run **crashed**. MVP does NOT auto-resume: mark the item `failed` (`failure={phase, reason:'workflow crashed'}`), block dependents (§Q4), post "⚠️ [id] crashed at [phase] — halting for a human", and **STOP**.

**C. (reached only via A/B falling through, i.e. nothing is running now.)**

**D. Pick next runnable** (§Q7 query: `pending` AND every `dependsOn` is `done`).
   - **A runnable item** → mark it `running`, launch its **plan** phase (§Q3), persist, schedule the heartbeat (§Q5), **STOP**.
   - **None runnable and nothing running** → queue drained (or fully blocked) → §Q6 roll-up + finish. Do NOT re-arm the heartbeat.

## Q3. Running one item through its phases

Mirror single-plan §2, but persist between phases and report id-prefixed. For the current item `I`:

**Conventions for every phase launch:**
- **Resolve `I.planPath` to an absolute path** (join with `workspaceRoot` if relative) before passing it to `Workflow` — the forge agents read the path directly and a relative path will not resolve on the remote.
- The `Workflow` tool result prints both a `Task ID` and a `Run ID`. **Record the `Task ID`** into `I.taskId` — that is the value the completion `<task-notification>`'s `<task-id>` carries and what `TaskOutput` expects.
- After recording results, **merge** warnings, don't overwrite: `result.warnings = (result.warnings // []) + <this phase's warnings>`.

- **Launch plan:** set `I.status=running, I.phaseReached=plan`, launch `Workflow({scriptPath: FORGE_WF, args:{phase:'plan', planPath:I.planPath, workspaceRoot}})`, record the returned task id into `I.taskId`, persist. Stop (await notification).
- **On plan done:** record `result.planRounds/planConverged` **and `result.scenarios`** (the detected-scenario array). If the notification status was `failed` (threw) → §Q4 retry/fail. Otherwise run `cd <workspaceRoot>/.forge/codex && PYTHONPATH=. python3 -m forge_codex.cli checklist-advise <absolute-checklist-path> --execute --json`; review advisories and findings as in single-plan §2, correcting the checklist before continuing. Do not use whole-file exact grep occurrence counts as dependency checks. Then post `📋 [I.id] Plan: …`, **launch build** passing `scenarios: I.result.scenarios` (set `phaseReached=build`, new `taskId`), persist, stop.
- **On build done:** record `result.checklistItems/repos/implemented`. If `status:'no-op'` → mark `I.status=done` with a "nothing to implement" note, then §Q2 pick next. If notification `failed` → §Q4. Else post `🔨 [I.id] Build: …`, **launch ship** passing `implemented: I.result.implemented` **and `scenarios: I.result.scenarios`** (set `phaseReached=ship`, new `taskId`), persist, stop.
- **On ship done:** record `result.shipped/codeRoundsByRepo`, append any `warnings`. **If ship hard-failed (notification `failed`) → do NOT retry ship** (double-commit/push risk): mark `I.status=failed`, `failure={phase:'ship', …}`, §Q4 block dependents, post `❌ [I.id] ship failed — halting for a human`, **STOP the drain**. Else mark `I.status=done`, post the per-item verdict, then §Q2 pick next.

**Soft warnings ≠ failure.** A phase that completes with a non-empty `warnings` array (tests not green, didn't converge, committed-not-pushed) is still `done` — record the warnings for the roll-up and proceed. Do not retry on soft warnings (build already self-heals tests twice; re-running risks double work). Only a `failed` notification (a throw) or a crash triggers §Q4.

## Q4. Failure / retry / dependency policy

- **Hard fail on plan or build** (notification `failed`): `I.attempts++`. If `attempts < maxAttempts`, re-launch the **same** phase (leave `phaseReached`). Else mark `I.status=failed`, set `failure`, block dependents, and **continue** with other runnable items (one bad plan must not stall independents).
- **Hard fail on ship:** never auto-retry → mark `failed`, block dependents, **halt the drain**, surface for a human (ship is mid-commit/push; a human must inspect git state).
- **Block dependents:** when any item becomes `failed`/`blocked`, mark every still-`pending` item that (transitively) `dependsOn` it as `blocked` (§Q7 fixpoint). Blocked + failed items stay in the file as a dead-letter record — never delete them.

## Q5. Stall heartbeat

Primary advancement is the completion notification (immediate). The heartbeat is the **only** safety net for a hung phase or a dropped notification:

- After launching any phase, call `ScheduleWakeup({ delaySeconds: 1800, prompt: '/forge queue', reason: 'forge-queue heartbeat: verify in-flight phase' })`.
- On a heartbeat wake, run §Q2 (branch **B**'s liveness check handles it).
- **Stop re-arming once the queue is drained / halted** (Q6), or you will self-wake forever on an idle queue.

## Q6. Roll-up + finish

When no item is `running` and none is runnable:

- Post a compact table — one row per item: `id | status | planRounds | shipRounds | shipped (repos/deploy) | warnings-or-failure-reason`.
- Lead with anything that went sideways (failed/blocked/warnings); if all `done` clean, say so.
- Send **one** `PushNotification` (walk-away): "forge queue: N done, M failed, K blocked — <headline>."
- Do **not** schedule another heartbeat. Done.

## Q7. Canonical jq helpers (use these — don't hand-edit JSON)

Let `Q=.forge/queue.json`. Always `cp -f "$Q" "$Q.bak"` before a mutation.

**Next runnable id (or NONE):**
```sh
jq -r '([.items[]|select(.status=="done")|.id]) as $done
  | [.items[]|select(.status=="pending" and ((.dependsOn-$done)|length==0))][0].id // "NONE"' "$Q"
```

**Set fields on one item (atomic):**
```sh
cp -f "$Q" "$Q.bak"
jq --arg id "$ID" '(.items[]|select(.id==$id)) |= (.status="running" | .phaseReached="plan" | .taskId="<taskid>")' \
  "$Q" > "$Q.tmp" && mv -f "$Q.tmp" "$Q"
```

**Block dependents to a fixpoint (depth-safe for small queues):**
```sh
cp -f "$Q" "$Q.bak"
jq 'def step:
      ([.items[]|select(.status=="failed" or .status=="blocked")|.id]) as $bad
      | .items |= map(if (.status=="pending" and (.dependsOn|any(. as $d|$bad|index($d))) ) then (.status="blocked") else . end);
    step|step|step|step|step' "$Q" > "$Q.tmp" && mv -f "$Q.tmp" "$Q"
```

## Q-notes / known gaps (this MVP cut)

- **No inbox channel yet** — to enqueue while a drain is live, append a `pending` item directly to `items[]` (the driver re-reads before each mutation, so it's picked up at the next dispatch). Small clobber window if you edit exactly as the driver writes; acceptable for a single operator.
- **No automatic crash resume** — a crashed `running` item halts the drain for a human (Q2.4) rather than silently re-running (ship double-commit risk). Resume by fixing state and re-invoking `/forge queue`.
- **Sequential only** — items run one at a time by design (plans often touch shared code).
- **Session death pauses the queue** — the file is durable; resume with `/forge queue`.
