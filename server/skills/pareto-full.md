# Pareto Improvement Skill

## Purpose

This skill ensures that any chosen solution has been rigorously evaluated across multiple
quality dimensions, iteratively improved, and stripped of dominated alternatives — so the
user is presented only with genuinely distinct, frontier-quality options and a clear picture
of the trade-offs between them.

The core insight: most tasks have 6–12 quality dimensions that matter, but people (and LLMs)
tend to implicitly collapse them into a single "goodness" score. This skill forces explicit,
independent scoring on each dimension, uses Pareto dominance to eliminate inferior options,
and then iteratively improves survivors until the frontier stabilizes.

## Inputs

The skill accepts three inputs. Only the first is required:

1. **Task description** (required) — What the user wants to accomplish.
2. **Required dimensions** (optional) — Quality dimensions the user wants guaranteed in the
   evaluation. These get merged into the auto-generated set. Expressed naturally, e.g.,
   "don't regress on test coverage" or "keep latency low."
3. **Candidate count** (optional) — How many initial candidate solutions to generate.
   Default: 8. Reasonable range: 5–12.

## Workflow

### Phase 1: Dimension Discovery

Analyze the task and generate 6–12 quality dimensions. Each dimension must be:

- **Independent**: Scoring high on one dimension should not mechanically guarantee a high
  score on another. If two proposed dimensions are strongly correlated, merge them or drop one.
- **Measurable**: Each dimension needs a clear definition of what a 1 vs. a 5 vs. a 10 means.
  Define these anchors explicitly before scoring anything.
- **Relevant**: Every dimension must plausibly differentiate between candidate solutions.
  If all candidates would score the same on a dimension, drop it.

Merge in any user-specified dimensions. If a user says something like "don't break the tests,"
translate that into a concrete dimension (e.g., "Test suite compatibility — likelihood that
existing tests continue to pass without modification").

**Output to user**: Present the dimension list with brief definitions and scoring anchors.
Ask the user to confirm, add, or remove dimensions before proceeding. Keep this quick — a
short numbered list, not an essay.

Example dimensions for a code refactoring task:
1. Correctness (1 = likely introduces bugs, 10 = provably equivalent behavior)
2. Readability (1 = significantly harder to follow, 10 = dramatically clearer)
3. Performance (1 = measurably slower, 10 = measurably faster)
4. Test compatibility (1 = breaks many tests, 10 = all tests pass, no changes needed)
5. Extensibility (1 = harder to modify later, 10 = opens up new extension points)
6. Migration effort (1 = large, risky changeset, 10 = minimal, safe diff)
7. Dependency impact (1 = adds or complicates dependencies, 10 = reduces/simplifies)

### Phase 2: Candidate Generation

Generate N candidate solutions (where N is the user-specified count or default 8). Each
candidate must be **meaningfully distinct** — not minor variations of the same idea. Aim
for genuine strategic diversity: different architectures, different trade-off profiles,
different philosophical approaches.

For each candidate, provide:
- A short descriptive name (2–5 words)
- A concise description of the approach (2–4 sentences)
- Scores on each dimension (1–10 scale)
- A brief justification for each score (1 sentence)

**Critical: Score each dimension independently.** Do not let a general impression of a
candidate's quality bleed across dimensions. A candidate can score 9 on correctness and 3
on readability. Actively resist the halo effect. If you notice all your scores for a
candidate clustering around the same number, stop and re-evaluate each dimension from scratch.

Present the initial scoring matrix to the user as a table.

### Phase 3: Pareto Culling

A candidate is **Pareto-dominated** if another candidate scores equal-or-higher on every
single dimension. Dominated candidates are eliminated.

Formally: Candidate A dominates Candidate B if and only if:
- For all dimensions i: score_A[i] >= score_B[i]
- For at least one dimension j: score_A[j] > score_B[j]

Perform this comparison for all pairs. Report which candidates were eliminated and which
candidate dominated them. Be explicit: "Option 3 (Quick Patch) was dominated by Option 7
(Modular Rewrite) — equal or better on all 7 dimensions."

If very few candidates are eliminated (e.g., 0–1 out of 8), that's fine — it means you
generated genuinely diverse options. If most candidates are eliminated, it may indicate
the scoring wasn't independent enough; review whether the halo effect crept in.

### Phase 4: Frontier Improvement

For each surviving candidate on the Pareto frontier:

1. Identify its 2–3 weakest dimensions.
2. Propose specific, targeted modifications to improve those weak dimensions.
3. Re-score the improved version on ALL dimensions (not just the ones you tried to improve).
   Improvements to weak dimensions sometimes cause regression on strong ones — catch this.
4. If the improved version dominates the original, it replaces it. If it's a new trade-off
   (better on some, worse on others), keep both and re-run Pareto culling on the expanded set.

**Important**: Improvements must be concrete and specific, not hand-wavy. "Make it more
readable" is not an improvement. "Extract the validation logic into a named function and
add docstrings to the three public methods" is an improvement.

### Phase 5: Convergence

Repeat Phase 4 for up to 3 rounds, or until either:
- No candidate's weakest dimension improves by more than 1 point, or
- The frontier is stable (same candidates survive two consecutive rounds)

Keep the intermediate rounds concise. The user doesn't need to see every scoring matrix
for every round. Summarize: "Round 2: Improved Option 7's readability from 5→7 by
extracting helper functions. Option 2's migration effort improved from 4→6 with a phased
rollout plan. No candidates eliminated this round. Frontier stable — proceeding to results."

### Phase 6: Present the Frontier

Present the final surviving options in a clear comparison format:

1. **Scoring matrix** — A table with candidates as rows and dimensions as columns.
2. **Trade-off summary** — For each candidate, a plain-language description of what it
   excels at and what it sacrifices. Frame these as genuine trade-offs, not as flaws:
   "Option A prioritizes correctness and safety at the cost of migration effort.
   Option B prioritizes speed of delivery at the cost of long-term extensibility."
3. **Recommendation context** — Without choosing for the user, indicate which option
   suits which priority. "If your top priority is shipping quickly, Option B. If you
   need to be confident nothing breaks, Option A."

Do NOT collapse to a single recommendation unless the user explicitly asks "just pick one."
The whole point is to present the genuine decision surface.

## Scoring Integrity Rules

These rules prevent the most common failure modes in multi-objective evaluation:

1. **No implicit scalarization.** Never average scores across dimensions or describe a
   candidate as "the best overall." Each dimension stands on its own.
2. **No halo effect.** Score each dimension independently. If you find yourself thinking
   "this is a strong candidate" before scoring individual dimensions, stop. Score the
   weakest-seeming dimension first.
3. **No phantom precision.** If you can't distinguish between a 6 and a 7 on a dimension,
   say so. Ties are fine and expected. Don't manufacture differentiation.
4. **No hidden dimensions.** If you find yourself thinking "but this option just feels
   better," identify what dimension that feeling corresponds to and add it explicitly.
5. **Justify every score.** Even one sentence per score prevents lazy pattern-matching.
   The justification must reference something specific about the candidate, not just
   restate the dimension definition.

## Adaptation by Context

The skill works across many domains. Here's how it adapts:

**Code changes**: Dimensions typically include correctness, readability, performance, test
compatibility, diff size, dependency impact, extensibility. Candidates are concrete
implementation approaches.

**Business decisions**: Dimensions typically include cost, revenue impact, risk, time to
implement, team capacity, customer impact, strategic alignment. Candidates are action plans.

**Writing/creative**: Dimensions typically include clarity, voice consistency, engagement,
accuracy, structure, audience appropriateness. Candidates are drafts or structural approaches.

**Architecture/design**: Dimensions typically include scalability, complexity, cost,
time-to-market, team familiarity, operational overhead, flexibility. Candidates are
architectural patterns or technology choices.

## Output Format

The final output should always include:

1. A summary of the process (how many candidates generated, how many rounds, how many
   eliminated)
2. The final scoring matrix as a table
3. The trade-off narrative for each surviving option
4. A clear invitation for the user to choose, with context to support their decision

If only one candidate survives (all others dominated), present it with confidence but
still show its dimension scores so the user understands its profile.

If the user asks for a single recommendation after seeing the frontier, it's fine to
give one — but frame it as "given that your stated priorities are X and Y, I'd lean
toward Option A because..." rather than claiming objective superiority.

## Required Output Format

After completing the Pareto analysis, you MUST output your final proposals as a JSON array
wrapped in XML tags exactly like this:

<task-proposals>
[
  {
    "title": "Short imperative title",
    "description": "Detailed description of what to change and how",
    "rationale": "Why this matters — impact on quality/performance/security",
    "estimatedEffort": "small|medium|large",
    "rank": 1,
    "rankingScore": 8.5,
    "rankingReason": "Brief explanation of why this task is ranked at this position"
  }
]
</task-proposals>

Number proposals from 1 (highest priority) in the `rank` field. Assign a `rankingScore` (1-10 scale, 10 = highest impact/effort ratio) and a brief `rankingReason` explaining the ranking.

Each proposal must be:
- **Actionable** — A developer could start implementing immediately
- **Scoped** — One logical change, not a mega-refactor
- **Justified** — Clear rationale for why this is high-value
