export const meta = {
  name: 'forge',
  description: 'Plan → implement → polish → ship a task across a multi-repo workspace. Phase-dispatched (plan|build|ship) so the /forge driver can report progress between phases.',
  whenToUse: 'Driven by the /forge command, which calls it once per phase. plan = refine the plan to convergence; build = checklist + implement; ship = polish the code to convergence + commit/push/deploy. phase:"all" runs the whole pipeline in one background run.',
  phases: [
    { title: 'Refine Plan', detail: 'material-driven loop ≤6 rounds: 6 lenses (concretize/investigate/bugs/safety/simplicity/test-strategy) carry per-lens memos + a synthesizer changelog; a holistic backstop critic catches cross-cutting gaps' },
    { title: 'Checklist', detail: 'turn the converged plan into an ordered, per-repo, verifiable checklist' },
    { title: 'Implement', detail: 'one implementer per repo (repos parallel, items sequential), build/test gate with a fix loop' },
    { title: 'Refine Code', detail: 'material-driven loop ≤3 rounds per repo: 4 lenses (correctness/delight/refactor/security) + backstop critic' },
    { title: 'Ship', detail: 'per changed repo: commit, push, discover the deploy path at runtime, deploy' },
  ],
}

// ---- Tunables -------------------------------------------------------------
const MAX_PLAN_ROUNDS = 6
const MAX_CODE_ROUNDS = 3
const PLAN_BACKSTOP_ROUNDS = 1   // extra targeted rounds the holistic backstop critic may trigger
const CODE_BACKSTOP_ROUNDS = 1
const MAX_SPECIALIST_LENSES = 2  // at most N detected-scenario specialist lenses added per round (top-ranked by classifier confidence), so a cross-cutting plan can't explode the agent count

// ---- Inputs ---------------------------------------------------------------
// Be tolerant of args arriving as a JSON-encoded STRING (a common caller mistake)
// as well as a proper object — otherwise `args.planPath` is silently undefined.
let ARGS = args
if (typeof ARGS === 'string') { try { ARGS = JSON.parse(ARGS) } catch (e) { ARGS = {} } }
ARGS = ARGS || {}
const phaseArg = ARGS.phase || 'all'
const planPath = ARGS.planPath
const workspaceRoot = ARGS.workspaceRoot || '.'

// ---- Shared rubrics (one definition of "good", read by lenses AND critics) -
const PLAN_RUBRIC = `A plan is DONE when ALL hold:
- every proposed change is captured as a concrete unified diff (repo + file + diff), not prose;
- every open question is resolved, or explicitly deferred with a written rationale;
- spikes have de-risked the genuine unknowns (you actually probed code / ran experiments);
- there are no contradictions, gaps, or hand-waves;
- acceptance criteria for each change are concrete and testable.`

const CODE_RUBRIC = `Edited code is DONE when ALL hold:
- correctness: no bugs, no broken edge cases, tests pass;
- delight: the user-facing experience is smooth and considered (errors, empty states, latency, copy);
- beauty: code reads clearly, names are honest, no dead/duplicated code;
- maintainability: no obvious refactor left on the table, structure matches the surrounding code.`

// ---- Schemas --------------------------------------------------------------
const PLAN_DELTA = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    hasMaterialFindings: { type: 'boolean', description: 'true ONLY if you found something that would change an implementation decision or catch a real defect this round; false for mere elaboration/restating or if the plan already covers your concern' },
    materialityJustification: { type: 'string', description: 'one line: if material, why it matters; if not, why there was nothing material to add' },
    summary: { type: 'string', description: 'what this lens changed/learned this round (may be empty when not material)' },
    edits: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { section: { type: 'string' }, change: { type: 'string' } },
      required: ['section', 'change'] } },
    diffs: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { repo: { type: 'string' }, file: { type: 'string' }, unifiedDiff: { type: 'string' } },
      required: ['repo', 'file', 'unifiedDiff'] } },
    resolvedQuestions: { type: 'array', items: { type: 'string' } },
    carryforward: { type: 'string', description: 'a short note to your FUTURE SELF for next round: what you have already covered, what you deferred, and what you are still watching — so you do not re-derive it' },
  },
  required: ['lens', 'hasMaterialFindings', 'materialityJustification', 'summary', 'edits', 'diffs', 'resolvedQuestions', 'carryforward'],
}

// Returned by the synthesizer/applier so the NEXT round's lenses review the delta, not the whole artifact.
const CHANGELOG = {
  type: 'object', additionalProperties: false,
  properties: { changelog: { type: 'string', description: '3-5 lines: what materially changed this round and where' } },
  required: ['changelog'],
}

const PLAN_CRITIC = {
  type: 'object', additionalProperties: false,
  properties: {
    materialGain: { type: 'boolean', description: 'true if the plan can still be materially improved against the rubric' },
    score: { type: 'number', description: '0-100 against the rubric' },
    rationale: { type: 'string' },
    openIssues: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        issue: { type: 'string' },
        lens: { type: 'string', enum: ['concretize', 'investigate', 'bugs', 'safety', 'simplicity', 'test-strategy'] },
      },
      required: ['issue', 'lens'] } },
  },
  required: ['materialGain', 'score', 'rationale', 'openIssues'],
}

const CHECKLIST = {
  type: 'object', additionalProperties: false,
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' },
        repo: { type: 'string', description: 'absolute path to the repo this item changes' },
        files: { type: 'array', items: { type: 'string' } },
        change: { type: 'string' },
        acceptance: { type: 'string', description: 'concrete, testable done-criterion' },
      },
      required: ['id', 'repo', 'files', 'change', 'acceptance'] } },
  },
  required: ['items'],
}

const IMPLEMENT_RESULT = {
  type: 'object', additionalProperties: false,
  properties: {
    repo: { type: 'string' },
    done: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    editedFiles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    failureNotes: { type: 'string' },
  },
  required: ['repo', 'done', 'testsPassed', 'editedFiles', 'summary', 'failureNotes'],
}

const CODE_DELTA = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    hasMaterialFindings: { type: 'boolean', description: 'true ONLY if you found a real defect/improvement worth changing the code for this round; false for nitpicks or if the code already meets your concern' },
    materialityJustification: { type: 'string', description: 'one line: if material, why it matters; if not, why there was nothing material' },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } },
      required: ['file', 'issue', 'fix'] } },
    carryforward: { type: 'string', description: 'a short note to your FUTURE SELF for next round: what you already reviewed/fixed and what you are still watching — so you do not re-review it' },
  },
  required: ['lens', 'hasMaterialFindings', 'materialityJustification', 'summary', 'findings', 'carryforward'],
}

const CODE_CRITIC = {
  type: 'object', additionalProperties: false,
  properties: {
    materialGain: { type: 'boolean' },
    beautiful: { type: 'boolean' },
    maintainable: { type: 'boolean' },
    score: { type: 'number' },
    rationale: { type: 'string' },
    openIssues: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        issue: { type: 'string' },
        lens: { type: 'string', enum: ['correctness', 'delight', 'refactor', 'security'] },
      },
      required: ['issue', 'lens'] } },
  },
  required: ['materialGain', 'beautiful', 'maintainable', 'score', 'rationale', 'openIssues'],
}

const SHIP_REPORT = {
  type: 'object', additionalProperties: false,
  properties: {
    repo: { type: 'string' },
    committed: { type: 'boolean' },
    pushed: { type: 'boolean' },
    deployed: { type: 'boolean' },
    commitSha: { type: 'string' },
    deployMethod: { type: 'string', description: 'how deploy was discovered + run, or why skipped' },
    notes: { type: 'string' },
  },
  required: ['repo', 'committed', 'pushed', 'deployed', 'commitSha', 'deployMethod', 'notes'],
}

// ---- Lenses ---------------------------------------------------------------
const PLAN_LENSES = [
  { lens: 'concretize',    task: 'Make the plan concrete: flesh out vague steps with specifics AND express the key code changes as unified diffs (repo + file + diff). Prefer real diffs over prose.' },
  { lens: 'investigate',   task: 'Reduce unknowns: run spikes (actually open the referenced code and run small experiments/commands) AND research open questions against the codebase and the web. Think of interesting/edge-case inputs and trace concrete end-to-end paths through the code (entry point → each hop → output) to see how the change actually behaves. Fold what you learn into the plan; flag anything unresolved for explicit deferral.' },
  { lens: 'bugs',          task: 'Adversarially hunt for bugs, gaps, contradictions, and wrong assumptions in the plan. Default to skeptical.' },
  { lens: 'safety',        task: 'Cover security AND risk: authz, secret/credential handling, PII, input trust boundaries; plus failure modes and the rollback story (migrations, feature flags, how to back out safely, blast radius if it breaks production).' },
  { lens: 'simplicity',    task: 'Counterweight to detail-adding: hunt for over-engineering and scope creep. What can be cut, deferred, or simplified (YAGNI) while still meeting the goal?' },
  { lens: 'test-strategy', task: 'Define how we will PROVE the change works before/while coding: what to test, at which level, and the concrete acceptance checks.' },
]

const CODE_LENSES = [
  { lens: 'correctness', task: 'Hunt for and fix bugs and broken edge cases in the edited code (default skeptical), AND ensure adequate automated test coverage — ADD missing tests for new/changed behavior and edge cases (do not merely verify — write the tests).' },
  { lens: 'delight',     task: 'Make the user-facing experience a delight: error/empty/loading states, copy, latency, polish.' },
  { lens: 'refactor',    task: 'Improve clarity and maintainability: honest names, remove dead/duplicated code, match surrounding style.' },
  { lens: 'security',    task: 'Review the edited code for security issues: input validation, injection, authz checks, and safe handling of secrets/credentials. Fix what you find.' },
]

// ---- Specialist lenses (activated per-plan by the upfront scenario detector) ----
// Each entry is keyed by its scenario flag. `hint` is a one-line gotcha summary (folded
// cheaply into the implementer prompt); `planTask`/`codeTask` are the dedicated specialist
// lens prompts used in the plan-refine and code-refine loops respectively.
const SPECIALISTS = {
  ui: {
    label: 'UI / frontend',
    hint: 'delight, empty/loading/error states, responsive + mobile-viewport, accessibility/contrast, copy',
    planTask: 'UI/UX specialist: make sure the plan delivers a delightful, appealing interface — it specifies empty/loading/error states, responsive + mobile-viewport behavior, accessibility (labels/contrast/focus order), and clear copy. Flag any UX decision the plan leaves implicit.',
    codeTask: 'UI/UX specialist: verify the edited UI is genuinely delightful and appealing — polished empty/loading/error states, responsive layout with no mobile-viewport overflow, accessible (labels/contrast/focus), and considered copy. Fix what falls short.',
  },
  ios: {
    label: 'iOS',
    hint: 'main-thread UI, retain cycles, lifecycle, Keychain, background modes, App Store review',
    planTask: 'iOS specialist: surface iOS-specific gotchas the plan must address — main-thread-only UI updates, retain cycles/memory, view & app lifecycle, Keychain for secrets, background modes, and App Store review constraints.',
    codeTask: 'iOS specialist: check the edited Swift/Obj-C for iOS gotchas — UI mutated off the main thread, retain cycles (use [weak self]), lifecycle correctness, Keychain usage for secrets, and App Store review risks. Fix what you find.',
  },
  android: {
    label: 'Android',
    hint: 'lifecycle/config-change, ANR, runtime permissions, Play review, install path',
    planTask: 'Android specialist: surface Android gotchas the plan must handle — activity/fragment lifecycle & config changes, main-thread/ANR risks, runtime permissions, and Play Store review constraints.',
    codeTask: 'Android specialist: check the edited Kotlin/Java for Android gotchas — lifecycle & config-change handling, main-thread/ANR risks, runtime permissions, and leaks. Fix what you find.',
  },
  api: {
    label: 'Backend HTTP API',
    hint: 'idempotency, status codes, pagination, input validation, rate limits, versioning',
    planTask: 'API specialist: ensure the plan gets the HTTP contract right — idempotency, correct status codes, pagination, request validation, rate limiting, and backward-compatible versioning.',
    codeTask: 'API specialist: review the edited endpoints — idempotency, status codes, pagination, request validation, and contract/version compatibility. Fix what you find.',
  },
  migration: {
    label: 'DB / migration',
    hint: 'reversibility, lock duration, backfill, zero-downtime ordering, index cost',
    planTask: 'Migration specialist: make the plan safe for the database — the migration is reversible, lock duration is bounded, backfills are batched, the apply order is zero-downtime, and new indexes are justified.',
    codeTask: 'Migration specialist: review the edited migration/data code — reversibility, lock duration, batched backfill, and zero-downtime ordering. Fix what you find.',
  },
  auth: {
    label: 'Auth / secrets',
    hint: 'token scope, rotation, PII, secret-at-rest, authz on every path',
    planTask: 'Auth/secrets specialist: deepen the plan on identity & secrets — least-privilege token scope, rotation, PII handling, secrets-at-rest, and an authz check on every new path.',
    codeTask: 'Auth/secrets specialist: review the edited code for authz on every path, token scope, safe secret handling (never logged/committed), and PII exposure. Fix what you find.',
  },
  infra: {
    label: 'Infra / deploy / CI',
    hint: 'rollback, blast radius, env parity, health checks, deploy flow',
    planTask: 'Infra/deploy specialist: ensure the plan has a credible rollback story, bounded blast radius, env parity, health checks, and a concrete deploy/CI path.',
    codeTask: 'Infra/deploy specialist: review the edited infra/CI/deploy code — rollback safety, blast radius, env parity, and health checks. Fix what you find.',
  },
  concurrency: {
    label: 'Concurrency / async / workers',
    hint: 'races, idempotent retries, ordering, deadlock, backpressure',
    planTask: 'Concurrency specialist: surface race conditions, retry idempotency, ordering guarantees, deadlock and backpressure concerns the plan must address.',
    codeTask: 'Concurrency specialist: review the edited async/worker code for races, non-idempotent retries, ordering bugs, deadlock and backpressure. Fix what you find.',
  },
  external_api: {
    label: 'External-API integration',
    hint: 'rate limits, auth refresh, partial failure, schema drift, webhook replay',
    planTask: 'Integration specialist: ensure the plan handles third-party realities — rate limits, token/auth refresh, partial failure & retries, response schema drift, and webhook replay/idempotency.',
    codeTask: 'Integration specialist: review the edited integration code — rate-limit handling, auth refresh, partial-failure retries, and schema-drift tolerance. Fix what you find.',
  },
  llm: {
    label: 'LLM / AI integration',
    hint: 'token cost, prompt injection, prompt caching, model-version pinning, latency',
    planTask: 'LLM specialist: ensure the plan controls token cost, defends against prompt injection, uses prompt caching where it helps, pins the model version, and accounts for latency.',
    codeTask: 'LLM specialist: review the edited model-calling code — token cost, prompt-injection exposure, prompt caching, model-version pinning, and latency. Fix what you find.',
  },
  payments: {
    label: 'Payments / financial',
    hint: 'integer money math, idempotency keys, audit trail, reconciliation',
    planTask: 'Payments specialist: ensure the plan handles money correctly — integer/decimal (never float) amounts, idempotency keys on charges, an audit trail, and reconciliation.',
    codeTask: 'Payments specialist: review the edited financial code — no float money math, idempotent charges, audit trail, and reconciliation correctness. Fix what you find.',
  },
  realtime: {
    label: 'Realtime / streaming',
    hint: 'connection lifecycle, reconnect, ordering, backpressure',
    planTask: 'Realtime specialist: ensure the plan handles connection lifecycle, reconnect/resume, message ordering, and backpressure for streaming/websocket work.',
    codeTask: 'Realtime specialist: review the edited streaming/websocket code — connection lifecycle, reconnect/resume, ordering, and backpressure. Fix what you find.',
  },
  cli: {
    label: 'CLI / dev tooling',
    hint: 'exit codes, flag parsing, stdout/pipe discipline, idempotent re-run',
    planTask: 'CLI specialist: ensure the plan gets tooling ergonomics right — correct exit codes, clear flag parsing, clean stdout/stderr separation for piping, and safe idempotent re-runs.',
    codeTask: 'CLI specialist: review the edited CLI code — exit codes, flag parsing, stdout/stderr discipline, and idempotent re-run. Fix what you find.',
  },
}
const SCENARIO_FLAGS = Object.keys(SPECIALISTS)
const SCENARIO_CATALOG = Object.entries(SPECIALISTS).map(([flag, sp]) => `- ${flag}: ${sp.label} — ${sp.hint}`).join('\n')

const SCENARIO_DETECT = {
  type: 'object', additionalProperties: false,
  properties: {
    scenarios: { type: 'array', description: 'ONLY the scenarios the plan genuinely involves (omit the rest)', items: { type: 'object', additionalProperties: false,
      properties: {
        flag: { type: 'string', enum: SCENARIO_FLAGS },
        confidence: { type: 'number', description: '0-1: how central this scenario is to the plan' },
        why: { type: 'string', description: 'one line: what in the plan triggers this' },
      },
      required: ['flag', 'confidence', 'why'] } },
  },
  required: ['scenarios'],
}

// ---- Helpers --------------------------------------------------------------
function fmtIssues(issues) {
  if (!issues || !issues.length) return '(none)'
  return issues.map((o, i) => `  ${i + 1}. [${o.lens}] ${o.issue}`).join('\n')
}

// Detect which specialized scenarios a plan involves (once), so specialist lenses can activate.
// Precedence: explicit override > ARGS.scenarios (threaded by the /forge driver) > a cheap classifier pass.
// Returns a confidence-sorted array of { flag, confidence, why } for the scenarios that fired.
async function detectScenarios(override) {
  let fired = override || ARGS.scenarios
  if (!Array.isArray(fired)) {
    if (!planPath) return []  // no plan to read (e.g. a standalone ship) → base lenses only
    const res = await agent(
      `You are a fast plan CLASSIFIER. Read the plan at ${planPath} (workspace root: ${workspaceRoot}) and decide which ` +
      `specialized scenarios it genuinely involves, so the right specialist reviewers can be activated. Include a scenario ONLY ` +
      `if the plan really touches it; set confidence to how central it is. Omit everything that does not apply.\n\n` +
      `SCENARIO CATALOG:\n${SCENARIO_CATALOG}`,
      { label: 'detect-scenarios', model: 'haiku', schema: SCENARIO_DETECT },
    )
    fired = res && Array.isArray(res.scenarios) ? res.scenarios : []
  }
  // Sort by confidence desc, then dedupe by flag (keep the highest-confidence occurrence) so a
  // classifier that repeats a flag can't spawn duplicate specialist lenses or clobber a lens memo.
  const sorted = [...fired].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
  const seen = new Set()
  const out = []
  for (const s of sorted) {
    if (!s || !s.flag || seen.has(s.flag)) continue
    seen.add(s.flag)
    out.push(s)
  }
  return out
}

// Top-N specialist lenses for a side ('plan' | 'code'), ranked by classifier confidence.
// Unknown flags and scenarios lacking a task on this side are dropped.
function specialistLenses(scenarios, side) {
  const key = side === 'code' ? 'codeTask' : 'planTask'
  return scenarios
    .map((s) => ({ sp: SPECIALISTS[s.flag], flag: s.flag }))
    .filter((x) => x.sp && x.sp[key])
    .slice(0, MAX_SPECIALIST_LENSES)
    .map((x) => ({ lens: x.flag, task: x.sp[key] }))
}

// A compact gotcha block (approach-B, near-free) folded into the implementer prompt.
function specialistHints(scenarios) {
  const top = scenarios.map((s) => SPECIALISTS[s.flag]).filter(Boolean).slice(0, MAX_SPECIALIST_LENSES)
  if (!top.length) return ''
  return `\n\nDOMAIN GOTCHAS detected for this work — keep these in mind while implementing:\n` +
    top.map((sp) => `- ${sp.label}: ${sp.hint}`).join('\n')
}

// =========================================================================
// PHASE: plan — refine the plan to convergence (material-driven loop + backstop)
// =========================================================================
async function runPlanPhase(scenariosOverride) {
  if (!planPath) throw new Error('forge plan phase requires args.planPath (the markdown plan file to refine).')
  phase('Refine Plan')

  const scenarios = await detectScenarios(scenariosOverride)
  const planSpecialists = specialistLenses(scenarios, 'plan')
  const planLenses = [...PLAN_LENSES, ...planSpecialists]
  if (scenarios.length) log(`Scenarios: ${scenarios.map((s) => s.flag).join(', ')} → specialist plan lenses: ${planSpecialists.map((l) => l.lens).join(', ') || 'none'}`)

  let planOpenIssues = []      // material gaps routed by the backstop critic for a targeted round
  let planRound = 0
  let planAborted = false
  let planCritic = null        // last holistic backstop critic result
  const planMemos = {}         // per-lens carryforward note from that lens's previous round
  let planChangelog = ''       // synthesizer's summary of what changed last round

  // One refinement round: lenses propose MATERIAL-ONLY deltas, synthesizer applies them.
  async function planRefineRound() {
    planRound++
    const focus = planOpenIssues.length
      ? `MATERIAL GAPS routed from the holistic review — prioritize the ones for your lens (but address anything material you can):\n${fmtIssues(planOpenIssues)}`
      : `No routed gaps — sweep your lens for anything still MATERIAL.`
    const changelogBlock = planChangelog
      ? `WHAT CHANGED IN THE PLAN since your last pass (review THIS delta rather than re-reading everything from scratch):\n${planChangelog}`
      : ``

    const raw = await parallel(planLenses.map((L) => () => {
      const memo = planMemos[L.lens]
      const memoBlock = memo ? `YOUR OWN NOTE from your previous pass (don't re-derive what you already covered):\n${memo}` : `(this is your first pass on this plan)`
      return agent(
        `You are the "${L.lens}" lens refining a plan. ${L.task}\n\n` +
        `Read the plan at ${planPath} (workspace root: ${workspaceRoot}). Use your tools to read code and run probes as needed.\n\n` +
        `RUBRIC (shared by all lenses and the critic):\n${PLAN_RUBRIC}\n\n` +
        `${memoBlock}\n\n${changelogBlock}\n\n${focus}\n\n` +
        `MATERIALITY BAR — this is critical: only propose a change if it is MATERIAL, i.e. it would change an implementation ` +
        `decision or catch a real defect. Do NOT pad, restate, or elaborate for its own sake. If the plan already covers your ` +
        `concern, set hasMaterialFindings=false with empty edits/diffs. Justify your materiality call in one line. ` +
        `Always fill 'carryforward' with a note to your future self.\n\n` +
        `Do NOT rewrite ${planPath} yourself — the synthesizer owns the file. Return your proposed delta only.`,
        { label: `plan:${L.lens}#${planRound}`, phase: 'Refine Plan', schema: PLAN_DELTA },
      )
    }))
    planLenses.forEach((L, i) => { if (raw[i] && raw[i].carryforward) planMemos[L.lens] = raw[i].carryforward })

    const deltas = raw.filter(Boolean)
    const material = deltas.filter((d) => d.hasMaterialFindings)
    if (material.length) {
      const synth = await agent(
        `You are the plan SYNTHESIZER. Merge ONLY these MATERIAL lens deltas into the plan file at ${planPath}, ` +
        `editing the file in place (read it, then write the improved version). Resolve conflicts sensibly, ` +
        `keep code changes as fenced unified-diff blocks, keep the plan coherent and de-duplicated, and add NO padding.\n\n` +
        `Then return a 3-5 line CHANGELOG of what you materially changed and where, for the next round's lenses.\n\n` +
        `RUBRIC:\n${PLAN_RUBRIC}\n\n` +
        `MATERIAL DELTAS (JSON):\n${JSON.stringify(material, null, 2)}`,
        { label: `plan:synth#${planRound}`, phase: 'Refine Plan', model: 'sonnet', schema: CHANGELOG },
      )
      planChangelog = synth ? synth.changelog : '(synthesizer changelog unavailable this round)'
    }
    log(`Plan round ${planRound}/${MAX_PLAN_ROUNDS}: material lenses=${material.length}/${deltas.length} [${material.map((d) => d.lens).join(',') || 'none'}]`)
    return material.length
  }

  // Main loop: keep refining while lenses still surface MATERIAL findings (cheap, no critic).
  let planMaterial = await planRefineRound()
  while (planMaterial > 0 && planRound < MAX_PLAN_ROUNDS) {
    planOpenIssues = []
    planMaterial = await planRefineRound()
  }
  const planLensesQuiet = planMaterial === 0

  // Backstop: ONE holistic critic catches cross-cutting gaps. Kept on inherited (Opus) model.
  let planBackstopUsed = 0
  while (!planAborted && planRound < MAX_PLAN_ROUNDS) {
    planCritic = await agent(
      `You are the plan BACKSTOP CRITIC — a holistic reviewer; the per-lens passes have gone quiet. ` +
      `Read the plan at ${planPath} and judge the INTEGRATED whole strictly against the RUBRIC, hunting especially for ` +
      `CROSS-CUTTING gaps or contradictions a single-lens view would miss.\n\n` +
      `RUBRIC:\n${PLAN_RUBRIC}\n\n` +
      `The lenses that can fix things are: concretize, investigate, bugs, safety, simplicity, test-strategy. ` +
      `Record ONLY material openIssues and route each to the best lens. Set materialGain=false if the integrated plan already satisfies the rubric.`,
      { label: `plan:backstop#${planRound}`, phase: 'Refine Plan', schema: PLAN_CRITIC },
    )
    if (!planCritic) { planAborted = true; log(`Plan backstop critic skipped — stopping.`); break }
    if (!planCritic.materialGain || !planCritic.openIssues.length) { log(`Plan backstop: no material gaps (score=${planCritic.score}). Converged.`); break }
    if (planBackstopUsed >= PLAN_BACKSTOP_ROUNDS) { log(`Plan backstop still wants ${planCritic.openIssues.length} change(s) but its ${PLAN_BACKSTOP_ROUNDS}-round budget is used — stopping.`); break }
    planBackstopUsed++
    planOpenIssues = planCritic.openIssues
    log(`Plan backstop found ${planOpenIssues.length} material gap(s) — running a targeted round.`)
    await planRefineRound()
  }

  const planPendingFromBackstop = !!(planCritic && planCritic.materialGain && planCritic.openIssues && planCritic.openIssues.length)
  const planConverged = !planAborted && planLensesQuiet && !planPendingFromBackstop

  const warnings = []
  if (planAborted) warnings.push(`Plan refinement aborted on round ${planRound} (backstop critic skipped) — plan may be unfinished.`)
  else if (!planConverged) warnings.push(`Plan stopped without converging after ${planRound} round(s) (hit the ${MAX_PLAN_ROUNDS}-round cap with material work still pending).`)

  return { phase: 'plan', planPath, planRounds: planRound, planConverged, planAborted, scenarios, warnings }
}

// =========================================================================
// PHASE: build — checklist + implement
// =========================================================================
async function runBuildPhase(scenariosOverride) {
  if (!planPath) throw new Error('forge build phase requires args.planPath.')

  const scenarios = await detectScenarios(scenariosOverride)

  phase('Checklist')
  const checklist = await agent(
    `Read the converged plan at ${planPath}. Produce an ordered, atomic, verifiable implementation checklist. ` +
    `Each item must name the absolute repo path it changes (under ${workspaceRoot}), the files, the change, and a concrete testable acceptance criterion. ` +
    `Order items so dependencies come first. Also write a human-readable copy next to the plan as checklist.md.`,
    { label: 'checklist', phase: 'Checklist', schema: CHECKLIST, model: 'sonnet' },
  )
  const items = (checklist && checklist.items) || []
  const repos = [...new Set(items.map((it) => it.repo))]
  log(`Checklist: ${items.length} item(s) across ${repos.length} repo(s).`)
  if (!items.length) {
    return { phase: 'build', status: 'no-op', reason: 'Checklist was empty after planning.', checklistItems: 0, repos: [], implemented: [], scenarios, warnings: ['Checklist was empty — nothing to implement.'] }
  }

  // Implement: parallel across repos (separate repos => no shared files), sequential within a repo.
  phase('Implement')
  async function implementRepo(repo) {
    const repoItems = items.filter((it) => it.repo === repo)
    const list = repoItems.map((it, i) =>
      `${i + 1}. (${it.id}) ${it.change}\n   files: ${it.files.join(', ')}\n   accept: ${it.acceptance}`
    ).join('\n')

    let result = await agent(
      `Implement these checklist items IN ORDER in the repo at ${repo}. Do not rush; complete every item fully. ` +
      `Follow the plan at ${planPath} and the diffs in it. After implementing, build and run the repo's tests/linters ` +
      `(discover how from the repo itself) and report whether they pass.${specialistHints(scenarios)}\n\nITEMS:\n${list}`,
      { label: `impl:${repo.split('/').pop()}`, phase: 'Implement', schema: IMPLEMENT_RESULT },
    )
    let fixAttempt = 0
    while (result && !result.testsPassed && fixAttempt < 2) {
      fixAttempt++
      result = await agent(
        `Tests/build are failing in ${repo}. Diagnose and FIX so the build and tests pass. Do not weaken or skip tests to pass. ` +
        `Prior failure notes:\n${result.failureNotes}\n\nRe-run the build/tests and report.`,
        { label: `impl-fix:${repo.split('/').pop()}#${fixAttempt}`, phase: 'Implement', schema: IMPLEMENT_RESULT },
      )
    }
    return result
  }

  const implemented = (await parallel(repos.map((r) => () => implementRepo(r)))).filter(Boolean)
  implemented.forEach((r) => log(`Implemented ${r.repo}: done=${r.done}, tests=${r.testsPassed}, files=${r.editedFiles.length}`))

  const warnings = []
  if (implemented.length < repos.length) warnings.push(`${repos.length - implemented.length} repo implementer(s) errored/were skipped.`)
  implemented.forEach((r) => {
    if (!r.testsPassed) warnings.push(`${r.repo}: tests/build NOT passing after implement — ${r.failureNotes || 'see implementer notes'}.`)
    if (!r.done) warnings.push(`${r.repo}: implementer reported items left undone.`)
  })

  return { phase: 'build', checklistItems: items.length, repos, implemented, scenarios, warnings }
}

// =========================================================================
// PHASE: ship — refine code to convergence, then commit/push/deploy
// `implemented` is [{ repo, editedFiles, ... }] from the build phase.
// =========================================================================
async function runShipPhase(implementedInput, scenariosOverride) {
  const implemented = implementedInput || ARGS.implemented || []
  if (!implemented.length) {
    return { phase: 'ship', status: 'no-op', reason: 'No implemented repos passed to ship.', refined: [], shipped: [], warnings: ['Ship phase received no changed repos.'] }
  }
  const repos = [...new Set(implemented.map((r) => r.repo))]

  phase('Refine Code')
  const scenarios = await detectScenarios(scenariosOverride)
  const codeSpecialists = specialistLenses(scenarios, 'code')
  const codeLenses = [...CODE_LENSES, ...codeSpecialists]
  if (scenarios.length) log(`Scenarios: ${scenarios.map((s) => s.flag).join(', ')} → specialist code lenses: ${codeSpecialists.map((l) => l.lens).join(', ') || 'none'}`)
  async function refineRepo(repo, editedFiles) {
    const tag = repo.split('/').pop()
    const scope = editedFiles && editedFiles.length ? editedFiles.join(', ') : '(all files changed in this task)'
    let openIssues = []
    let round = 0
    let aborted = false
    let critic = null
    const memos = {}
    let changelog = ''

    async function round_() {
      round++
      const focus = openIssues.length
        ? `MATERIAL ISSUES routed from the holistic review — prioritize the ones for your lens:\n${fmtIssues(openIssues)}`
        : `No routed issues — sweep your lens for anything still MATERIAL.`
      const changelogBlock = changelog
        ? `WHAT CHANGED IN THE CODE since your last pass (review THIS delta rather than re-reading everything):\n${changelog}`
        : ``

      const raw = await parallel(codeLenses.map((L) => () => {
        const memo = memos[L.lens]
        const memoBlock = memo ? `YOUR OWN NOTE from your previous pass (don't re-review what you already cleared):\n${memo}` : `(this is your first pass on this code)`
        return agent(
          `You are the "${L.lens}" lens reviewing recently-edited code in ${repo}. ${L.task}\n\n` +
          `Scope (the just-edited files): ${scope}\n\n` +
          `RUBRIC (shared by all lenses and the critic):\n${CODE_RUBRIC}\n\n` +
          `${memoBlock}\n\n${changelogBlock}\n\n${focus}\n\n` +
          `MATERIALITY BAR — critical: only report a finding if it is MATERIAL (a real defect or a worthwhile improvement). ` +
          `No nitpicks, no restating. If the code already meets your concern, set hasMaterialFindings=false with empty findings. ` +
          `Justify your materiality call in one line. Always fill 'carryforward' with a note to your future self.\n\n` +
          `Return findings only — do NOT edit files (the applier owns edits this round).`,
          { label: `code:${L.lens}@${tag}#${round}`, phase: 'Refine Code', schema: CODE_DELTA },
        )
      }))
      codeLenses.forEach((L, i) => { if (raw[i] && raw[i].carryforward) memos[L.lens] = raw[i].carryforward })

      const deltas = raw.filter(Boolean)
      const material = deltas.filter((d) => d.hasMaterialFindings)
      const allFindings = material.flatMap((d) => d.findings)
      if (allFindings.length) {
        const applied = await agent(
          `You are the code APPLIER for ${repo}. Apply these MATERIAL review findings to the files, then re-run the build/tests. ` +
          `Apply edits carefully and serially; do not break the build. Do not weaken tests.\n\n` +
          `Then return a 3-5 line CHANGELOG of what you materially changed and where, for the next round's lenses.\n\n` +
          `FINDINGS (JSON):\n${JSON.stringify(allFindings, null, 2)}`,
          { label: `code:apply@${tag}#${round}`, phase: 'Refine Code', schema: CHANGELOG },
        )
        changelog = applied ? applied.changelog : '(applier changelog unavailable this round)'
      }
      log(`Refine ${tag} round ${round}/${MAX_CODE_ROUNDS}: material lenses=${material.length}/${deltas.length} [${material.map((d) => d.lens).join(',') || 'none'}]`)
      return material.length
    }

    let mat = await round_()
    while (mat > 0 && round < MAX_CODE_ROUNDS) { openIssues = []; mat = await round_() }
    const lensesQuiet = mat === 0

    let backstopUsed = 0
    while (!aborted && round < MAX_CODE_ROUNDS) {
      critic = await agent(
        `You are the code BACKSTOP CRITIC for ${repo} — a holistic reviewer; the per-lens passes have gone quiet. ` +
        `Review the edited code (${scope}) as an integrated whole strictly against the RUBRIC, hunting for cross-cutting issues a single lens would miss.\n\n` +
        `RUBRIC:\n${CODE_RUBRIC}\n\n` +
        `The lenses that can fix things are: correctness, delight, refactor, security. Record ONLY material openIssues and route each to a lens. ` +
        `Set materialGain=false if the code already satisfies the rubric.`,
        { label: `code:backstop@${tag}#${round}`, phase: 'Refine Code', schema: CODE_CRITIC },
      )
      if (!critic) { aborted = true; log(`Code backstop critic skipped for ${tag} — stopping.`); break }
      if (!critic.materialGain || !critic.openIssues.length) { log(`Refine ${tag} backstop: no material gaps (score=${critic.score}). Converged.`); break }
      if (backstopUsed >= CODE_BACKSTOP_ROUNDS) { log(`Refine ${tag} backstop still wants ${critic.openIssues.length} change(s) but its budget is used — stopping.`); break }
      backstopUsed++
      openIssues = critic.openIssues
      await round_()
    }

    const pendingFromBackstop = !!(critic && critic.materialGain && critic.openIssues && critic.openIssues.length)
    return { repo, finalScore: critic ? critic.score : null, rounds: round, aborted, converged: !aborted && lensesQuiet && !pendingFromBackstop }
  }

  const refined = (await parallel(
    implemented.map((r) => () => refineRepo(r.repo, r.editedFiles))
  )).filter(Boolean)

  // Ship: per changed repo, commit/push/discover-deploy/deploy.
  phase('Ship')
  const shipped = (await parallel(repos.map((repo) => () =>
    agent(
      `Ship the changes in the repo at ${repo}. Steps:\n` +
      `1. Verify there are real uncommitted/unpushed changes (git status). If none, skip and report committed=false with a note.\n` +
      `2. Stage and commit with a clear message summarizing the change. Follow the repo's own commit conventions and honor any commit-msg hook. Do NOT append a Co-Authored-By or other Claude/Anthropic attribution trailer unless the repo's recent history already uses one.\n` +
      `3. Push to the appropriate remote/branch.\n` +
      `4. DISCOVER this repo's deploy path from the repo itself — deploy script, Makefile target, CI workflow, fastlane, ` +
      `   a fleet/deploy-config catalog flow, package publish, or (for an iOS/Android app) device install + TestFlight / Android Firefly. ` +
      `   Do NOT assume a method; detect it. Then execute the deploy. If the repo has no deploy path, report deployed=false with why.\n` +
      `Report exactly what you did.`,
      { label: `ship:${repo.split('/').pop()}`, phase: 'Ship', schema: SHIP_REPORT },
    )
  ))).filter(Boolean)

  const warnings = []
  refined.forEach((r) => {
    if (r.aborted) warnings.push(`${r.repo}: code refine aborted (backstop critic skipped) — polish may be unfinished.`)
    else if (!r.converged) warnings.push(`${r.repo}: code refine stopped without converging after ${r.rounds} round(s) (hit the ${MAX_CODE_ROUNDS}-round cap with material work pending).`)
  })
  shipped.forEach((s) => {
    if (!s.committed) warnings.push(`${s.repo}: nothing committed — ${s.notes}.`)
    else if (!s.pushed) warnings.push(`${s.repo}: committed but NOT pushed — ${s.notes}.`)
    else if (!s.deployed) warnings.push(`${s.repo}: pushed but NOT deployed — ${s.deployMethod}.`)
  })
  if (shipped.length < repos.length) warnings.push(`${repos.length - shipped.length} repo ship step(s) errored/were skipped.`)

  return {
    phase: 'ship',
    refined,
    shipped,
    scenarios,
    codeRoundsByRepo: refined.map((r) => ({ repo: r.repo, rounds: r.rounds, finalScore: r.finalScore, converged: r.converged })),
    warnings,
  }
}

// =========================================================================
// Dispatch
// =========================================================================
if (phaseArg === 'plan') return await runPlanPhase()
if (phaseArg === 'build') return await runBuildPhase()
if (phaseArg === 'ship') return await runShipPhase()

if (phaseArg === 'all') {
  // Whole pipeline in one background run (no inter-phase chat reporting).
  const scenarios = await detectScenarios()  // detect once, thread through all three phases
  const planRes = await runPlanPhase(scenarios)
  const buildRes = await runBuildPhase(scenarios)
  if (buildRes.status === 'no-op') {
    return { status: 'no-op', reason: buildRes.reason, ...planRes, ...buildRes, warnings: [...planRes.warnings, ...buildRes.warnings] }
  }
  const shipRes = await runShipPhase(buildRes.implemented, scenarios)
  const warnings = [...planRes.warnings, ...buildRes.warnings, ...shipRes.warnings]
  return {
    status: 'complete',
    planPath,
    planRounds: planRes.planRounds,
    planConverged: planRes.planConverged,
    scenarios,
    checklistItems: buildRes.checklistItems,
    repos: buildRes.repos,
    implemented: buildRes.implemented,
    refined: shipRes.refined,
    codeRoundsByRepo: shipRes.codeRoundsByRepo,
    shipped: shipRes.shipped,
    wentSideways: warnings.length > 0,
    warnings,
  }
}

throw new Error(`forge: unknown phase "${phaseArg}" (expected plan | build | ship | all)`)
