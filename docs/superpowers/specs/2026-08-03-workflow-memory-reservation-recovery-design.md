# Workflow Memory and Reservation Recovery Design

**Date:** 2026-08-03  
**Status:** Approved for implementation planning

## Problem

The authorized preview canary for edition `2026-08-01` completed collection
through shortlisting, then all three `synthesize-1` attempts terminated with
`Worker exceeded memory limit`. Nothing was synthesized, validated, composed,
or published. The run recorded `$0.19377516` of model usage, while three
synthesis reservations remained `reserved` with a combined maximum cost of
`$0.300750`.

The failed run provides two concrete memory signals:

1. `runEditorialPipeline` retains the outputs of collection, normalization,
   enrichment, prefiltering, assessment, scoring, clustering, and shortlisting
   in the same function scope through synthesis. The serialized checkpoints
   preceding synthesis totaled roughly 36 MB; their in-memory object graphs
   require substantially more space.
2. `D1PipelineStore.readArtifact(runId, step)` queries every checkpoint row for
   the run and parses each event before discarding rows for other steps. The
   failed run therefore transferred and parsed the same large checkpoint set
   before attempting the missing synthesis checkpoint.

Normal provider exception handling cannot guarantee reservation release after
a platform memory termination because the isolate may die before the
provider's `catch` block executes. The Workflow's exhausted-step failure does,
however, return to the outer pipeline failure path: the August 1 run row was
durably updated to `retryable` with the memory-limit failure.

## Goals

- Keep only the current large stage output live while advancing from
  collection through shortlisting.
- Read and parse only checkpoint rows belonging to the requested step.
- Release still-reserved budget entries for the exact run after its Workflow
  has exhausted retries and reached the outer terminal failure path.
- Clean up the existing terminal August 1 reservation pattern once.
- Preserve the original pipeline error if reservation cleanup also fails.
- Preserve all editorial, grounding, coverage, authentication, publication,
  and monthly-budget gates.
- Deploy and verify the fix without starting another paid canary.

## Non-goals

- Splitting every synthesized item into a separate Cloudflare Workflow step.
- Changing source selection, scoring, shortlist budgets, summary prompts, model
  names, output-token limits, or quality floors.
- Automatically resuming or replaying a failed run.
- Reconstructing provider billing after a platform termination.
- Changing the Run Status page or its authenticated canary control.

## Chosen approach

Use a targeted three-part change:

1. Filter checkpoint reads at the D1 query boundary.
2. Scope sequential stage outputs so completed large arrays become eligible
   for collection before synthesis.
3. Release exact-run reservations in the outer terminal failure path and via
   an idempotent one-time migration for already-terminal runs.

This is preferred over a checkpoint-only change because retaining every stage
would leave uncertain memory headroom. It is preferred over per-item Workflow
steps because the failed run does not yet justify that orchestration and retry
complexity.

## Architecture

### Step-filtered checkpoint reads

`D1PipelineStore.readArtifact(runId, step)` will constrain its SQL query by
both run and step using bounded JSON extraction at the database boundary. Only
rows whose `event_json` declares the requested step may be returned to the
Worker. Existing chunk validation, ordering, schema parsing, and failure labels
remain unchanged.

`readCheckpoint` continues to rely on `readArtifact`; it therefore inherits the
same filtered behavior without a second broad scan.

The query must remain parameterized by run ID, event type, and step. It must not
construct SQL from the step string.

### Stage-scoped pipeline execution

The selection portion of `runEditorialPipeline` will move into a focused helper
that advances one stage at a time and returns only the shortlist. Its internal
control flow must not retain references to every prior stage output after the
next durable checkpoint is saved.

Composition still needs normalized items. Instead of keeping normalization
live through enrichment, assessment, clustering, shortlisting, synthesis, and
validation, the pipeline will reload the already-durable normalized artifact
immediately before composition. The reloaded value must pass the existing
`NormalizedItemsSchema` before use.

The helper changes object lifetime only. Stage order, schemas, checkpoint
names, attempt accounting, retries, persistence, and shortlist semantics remain
unchanged.

### Terminal reservation release

The repository will provide an idempotent run-level operation that updates only
rows matching all of these conditions:

- `run_id` equals the supplied run ID; and
- `status = 'reserved'`.

Matching rows become `released` with a bounded release timestamp. Rows already
`reconciled` or `released`, and rows owned by any other run, remain unchanged.
The operation returns the number and maximum reserved cost of rows it released
so the caller can record bounded diagnostics without copying reservation
details into Workflow state.

The production pipeline context will expose a terminal-cleanup callback backed
by that repository operation. After the outer pipeline failure path saves the
retryable run state, it invokes cleanup once and records a bounded audit event
containing only the released count and aggregate maximum cost. It then rethrows
the original pipeline error.

Temporary provider transport retries and temporary Workflow step retries do not
trigger run-level cleanup. Cleanup occurs only after the Workflow step has
exhausted its retries and control has returned to the outer pipeline failure
path.

If cleanup fails, the pipeline still rethrows the original failure. It makes a
best-effort bounded diagnostic for the cleanup failure without including SQL,
provider bodies, reservation IDs, authentication details, or secrets. A
cleanup failure must never replace or conceal the synthesis failure.

## Accounting policy

The user explicitly chose availability over perfect accounting after an
unobservable platform termination. Remaining exact-run reservations are
released even though a killed request may have crossed the provider boundary
without producing a durable usage event. This accepts a small undercounting
risk while preventing indefinite loss of monthly budget capacity.

Successfully recorded usage and reservations already marked `reconciled` are
never changed. Normal successful provider accounting remains authoritative.

## One-time cleanup migration

A new idempotent D1 migration will release reservations still marked
`reserved` when their owning run has status `retryable`, `partial`, `failed`,
or `published`. It does not touch `pending` or `running` runs, reconciled rows,
released rows, model-usage events, editions, or checkpoints.

This migration handles the three existing August 1 synthesis reservations and
the same already-terminal pattern if it exists elsewhere. Future terminal
failures are handled by the runtime cleanup path.

The migration changes only reservation lifecycle state. It does not restart,
resume, delete, or rewrite a Workflow run.

## Failure behavior

- A normal provider error continues to use the provider's per-call release
  behavior.
- A temporary Workflow step retry retains its current reservations until the
  retry succeeds or the step exhausts retries.
- An exhausted step error saves the run as retryable, releases remaining
  exact-run reservations, records bounded cleanup diagnostics, and rethrows the
  original error.
- A cleanup error preserves the original pipeline failure and records a generic
  bounded cleanup diagnostic when possible.
- No failure path may publish an edition, weaken a quality gate, or start a new
  Workflow instance.

## Testing

Implementation will follow test-driven development and cover:

1. A target checkpoint loads successfully without returning or parsing large or
   malformed rows belonging to other steps.
2. Chunk reconstruction and existing checkpoint validation still work for the
   requested step.
3. Selection stages preserve their current outputs and order while the pipeline
   reloads normalized data only when composition needs it.
4. A terminal pipeline error releases only the target run's `reserved` rows,
   leaves reconciled/released and other-run rows unchanged, and is idempotent.
5. Cleanup occurs after exhausted Workflow failure, not during temporary step or
   transport retries.
6. Cleanup failure does not mask the original pipeline error and records only a
   bounded generic diagnostic.
7. The migration releases the already-terminal reservation pattern but leaves
   active-run and non-reserved rows untouched; repeated migration execution is
   harmless.
8. Normal successful authorization, usage recording, reconciliation, checkpoint
   resume, editorial validation, and publication tests remain green.

Full application tests, Worker integration tests, type checking, evaluation,
production build, and whitespace checks must pass before deployment.

## Deployment and verification

The preview Worker will be deployed with the existing preview configuration and
`--keep-vars`. `OPENAI_API_KEY` must not be read, printed, replaced, or copied.
The migration will then be applied to the preview D1 database.

Read-only verification will confirm:

- the three August 1 reservations are no longer `reserved`;
- their reconciled and usage records are otherwise unchanged;
- no active-run reservation was modified;
- the August 1 run and edition state were not restarted or rewritten; and
- the deployed Worker exposes the existing authenticated site and Run Status
  page.

No canary, resume, replay, or other paid model operation is authorized by this
design. A future canary requires separate user approval.
