# Authenticated Canary Run Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible, authenticated Run Status form that starts one manual briefing Workflow for an editable edition date and safely reports success, duplicate dates, and failures.

**Architecture:** Keep the existing `POST /api/admin/runs` endpoint as the only run-creation authority. Add local UI state and request handling to `RunStatusPage`, reuse its existing run-list fetch after success, and add narrowly scoped styles in the global stylesheet. No API, authentication, Workflow, database, or secret changes are required.

**Tech Stack:** React 19, TypeScript, Testing Library, Vitest/jsdom, Hono Worker API, Cloudflare Access, Cloudflare Workflows, D1, Wrangler.

## Global Constraints

- Opening the page must never start a run.
- The date input defaults to the browser's local calendar date and remains editable.
- The submit button explicitly says “Start canary run” and the page states that the action may incur model costs.
- The browser sends only `{ "editionDate": "YYYY-MM-DD" }` as authenticated JSON to `POST /api/admin/runs`.
- The UI must not handle or store Cloudflare Access tokens.
- The form is disabled while the request is pending.
- `202` refreshes the run list and announces the returned run ID.
- `409` produces a specific duplicate-date message; all other failures use a generic safe message.
- Success uses `role="status"`; failures use `role="alert"`.
- Do not display provider bodies, authentication details, or internal errors.
- Preserve the server's one-run-per-edition-date behavior and all publication, grounding, coverage, and budget gates.
- Deploy preview with `--keep-vars`; never inspect, replace, or print `OPENAI_API_KEY`.

---

### Task 1: Implement the authenticated canary form

**Files:**
- Modify: `src/web/pages/RunStatusPage.tsx`
- Modify: `src/web/styles/global.css`
- Test: `tests/unit/web/RunStatusPage.test.tsx`
- Reference: `docs/superpowers/specs/2026-08-03-canary-run-control-design.md`

**Interfaces:**
- Consumes: existing `POST /api/admin/runs` request `{ editionDate: string }` and success response `{ runId: string }`.
- Consumes: existing `GET /api/runs` response `readonly WorkflowRun[]`.
- Produces: `localDateInputValue(date)` returning `YYYY-MM-DD` from `getFullYear()`, `getMonth()`, and `getDate()`.
- Produces: an inline form labeled by “Start canary run,” with date input, cost notice, pending state, and safe live-region feedback.

- [ ] **Step 1: Add a failing local-date/form test**

Add a helper object and test to `tests/unit/web/RunStatusPage.test.tsx`:

```tsx
import {
  RunStatusPage,
  localDateInputValue,
} from "../../../src/web/pages/RunStatusPage";

it("defaults the canary date from local calendar components", async () => {
  expect(localDateInputValue({
    getFullYear: () => 2026,
    getMonth: () => 7,
    getDate: () => 3,
  })).toBe("2026-08-03");

  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 3, 8, 30));
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
  render(<RunStatusPage />);

  expect(screen.getByLabelText("Edition date")).toHaveProperty(
    "value",
    "2026-08-03",
  );
  expect(screen.getByText("Starting a run may incur model costs.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start canary run" })).toBeTruthy();
  vi.useRealTimers();
});
```

Extend the test `afterEach` with `vi.useRealTimers()` so failures cannot leak fake time into later cases.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- --run tests/unit/web/RunStatusPage.test.tsx -t "defaults the canary date" --reporter=dot
```

Expected: FAIL because `localDateInputValue` and the “Edition date” form do not exist.

- [ ] **Step 3: Add the local-date helper and inert form**

In `src/web/pages/RunStatusPage.tsx`, import `FormEvent`, define a structural date type, and add the helper:

```tsx
import { useEffect, useState, type FormEvent } from "react";

type LocalDate = Pick<Date, "getFullYear" | "getMonth" | "getDate">;

export function localDateInputValue(date: LocalDate): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
```

Add state and render the form before the run list:

```tsx
const [editionDate, setEditionDate] = useState(() =>
  localDateInputValue(new Date())
);

function preventCanaryStart(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
}

<section className="canary-control" aria-labelledby="canary-control-heading">
  <h2 id="canary-control-heading">Start canary run</h2>
  <p>Starting a run may incur model costs.</p>
  <form onSubmit={preventCanaryStart}>
    <label htmlFor="canary-edition-date">Edition date</label>
    <input
      id="canary-edition-date"
      type="date"
      required
      value={editionDate}
      onChange={(event) => setEditionDate(event.currentTarget.value)}
    />
    <button type="submit">Start canary run</button>
  </form>
</section>
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command again.

Expected: PASS.

- [ ] **Step 5: Add a failing success/pending/list-refresh test**

Add a `deferredResponse()` test helper and a test that keeps the POST pending:

```tsx
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("starts one canary and refreshes the run list after success", async () => {
  const pending = deferredResponse();
  const initialRun = workflowRun("existing-run", "2026-08-02", "failed");
  const startedRun = workflowRun("2026-08-01", "2026-08-01", "pending");
  let listRequests = 0;
  const fetch = vi.fn(async (input: string | URL | Request) => {
    if (String(input) === "/api/admin/runs") return pending.promise;
    listRequests += 1;
    return jsonResponse(listRequests === 1 ? [initialRun] : [startedRun, initialRun]);
  });
  vi.stubGlobal("fetch", fetch);
  render(<RunStatusPage />);

  const date = await screen.findByLabelText("Edition date");
  fireEvent.change(date, { target: { value: "2026-08-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Start canary run" }));

  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    "/api/admin/runs",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editionDate: "2026-08-01" }),
    },
  ));
  expect((date as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", {
    name: "Starting canary run…",
  }) as HTMLButtonElement).disabled).toBe(true);

  pending.resolve(jsonResponse({ runId: "2026-08-01" }, 202));

  expect((await screen.findByRole("status")).textContent).toBe(
    "Canary run 2026-08-01 started.",
  );
  expect(await screen.findByRole("button", {
    name: "2026-08-01: pending",
  })).toBeTruthy();
  expect(listRequests).toBe(2);
});
```

Update `jsonResponse` to accept an optional status and add this fixture builder:

```tsx
function jsonResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}

function workflowRun(
  id: string,
  editionDate: string,
  status: WorkflowRun["status"],
): WorkflowRun {
  return {
    id,
    editionDate,
    status,
    currentStep: null,
    retryable: false,
    attemptCount: 0,
    failureCode: null,
    estimatedCostUsd: 0,
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  };
}
```

- [ ] **Step 6: Run the focused success test and verify RED**

Run:

```bash
npm test -- --run tests/unit/web/RunStatusPage.test.tsx -t "starts one canary" --reporter=dot
```

Expected: FAIL because the inert form never sends the POST or enters pending state.

- [ ] **Step 7: Implement the minimal success and pending flow**

Extract the existing list request into a component-local `loadRuns` function,
then add pending and feedback state:

```tsx
type StartFeedback =
  | { kind: "success"; message: string }
  | { kind: "failure"; message: string }
  | null;

const [starting, setStarting] = useState(false);
const [startFeedback, setStartFeedback] = useState<StartFeedback>(null);

async function loadRuns(signal?: AbortSignal) {
  const response = await fetch("/api/runs", signal === undefined ? {} : { signal });
  if (!response.ok) throw new Error("Run list request failed");
  setRuns(await response.json() as readonly WorkflowRun[]);
}

async function startCanary(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  setStarting(true);
  setStartFeedback(null);
  try {
    const response = await fetch("/api/admin/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editionDate }),
    });
    if (!response.ok) throw new Error("Canary start failed");
    const payload = await response.json() as { runId: string };
    setStartFeedback({
      kind: "success",
      message: `Canary run ${payload.runId} started.`,
    });
    await loadRuns();
  } finally {
    setStarting(false);
  }
}
```

Wire the form to `onSubmit={(event) => void startCanary(event)}`, disable the
input and button while `starting`, change the pending button label to
“Starting canary run…”, and render successful feedback with `role="status"`.

- [ ] **Step 8: Run the success test and existing page test**

Run:

```bash
npm test -- --run tests/unit/web/RunStatusPage.test.tsx --reporter=dot
```

Expected: both the new happy-path tests and the existing diagnostics test PASS.

- [ ] **Step 9: Add failing duplicate, malformed-success, HTTP-error, and network-error tests**

Add four separate tests so each behavior has one assertion target:

```tsx
it("explains when the selected edition date already has a run", async () => {
  stubRunListThenStart(jsonResponse({
    error: { code: "RUN_ALREADY_EXISTS", message: "A run already exists." },
  }, 409));
  render(<RunStatusPage />);
  await submitCanaryDate("2026-08-01");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "A run already exists for 2026-08-01. Choose another date.",
  );
});

it.each([
  ["malformed success", jsonResponse({}, 202)],
  ["HTTP failure", jsonResponse({}, 500)],
] as const)("uses a generic safe message for %s", async (_name, response) => {
  stubRunListThenStart(response);
  render(<RunStatusPage />);
  await submitCanaryDate("2026-08-01");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The canary run could not be started.",
  );
});

it("uses a generic safe message for a network failure", async () => {
  stubRunListThenStart(new Error("private provider detail"));
  render(<RunStatusPage />);
  await submitCanaryDate("2026-08-01");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The canary run could not be started.",
  );
  expect(document.body.textContent).not.toContain("private provider detail");
});
```

Implement `stubRunListThenStart` and `submitCanaryDate` as test-only helpers in
the test file; they exercise the real component and do not duplicate
production request logic:

```tsx
function stubRunListThenStart(result: Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (String(input) === "/api/runs") return jsonResponse([]);
    if (result instanceof Error) throw result;
    return result;
  }));
}

async function submitCanaryDate(editionDate: string) {
  fireEvent.change(await screen.findByLabelText("Edition date"), {
    target: { value: editionDate },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start canary run" }));
}
```

- [ ] **Step 10: Run the error tests and verify RED**

Run:

```bash
npm test -- --run tests/unit/web/RunStatusPage.test.tsx -t "already has a run|generic safe message" --reporter=dot
```

Expected: FAIL because `409`, malformed data, and thrown fetch errors are not yet converted into the specified safe feedback.

- [ ] **Step 11: Implement bounded response parsing and safe errors**

Add a parser that retains only a non-empty run ID:

```tsx
function startedRunId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("runId" in value)) {
    return null;
  }
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}
```

Update `startCanary`:

```tsx
if (response.status === 409) {
  setStartFeedback({
    kind: "failure",
    message: `A run already exists for ${editionDate}. Choose another date.`,
  });
  return;
}
if (!response.ok) throw new Error("Canary start failed");
const runId = startedRunId(await response.json().catch(() => null));
if (runId === null) throw new Error("Canary start response invalid");
setStartFeedback({
  kind: "success",
  message: `Canary run ${runId} started.`,
});
try {
  await loadRuns();
} catch {
  setFailed(true);
}
```

This nested refresh catch preserves the truthful “started” message if only the
list refresh fails. Add an outer `catch` that never renders the caught start
error:

```tsx
} catch {
  setStartFeedback({
    kind: "failure",
    message: "The canary run could not be started.",
  });
} finally {
  setStarting(false);
}
```

Render `failure` feedback with `role="alert"` and `success` feedback with
`role="status"`.

- [ ] **Step 12: Run the complete Run Status test file and verify GREEN**

Run:

```bash
npm test -- --run tests/unit/web/RunStatusPage.test.tsx --reporter=dot
```

Expected: all Run Status tests PASS with no unhandled promise rejection.

- [ ] **Step 13: Add narrowly scoped styling**

Add to `src/web/styles/global.css` near the existing `.state-page` rules:

```css
.canary-control {
  display: grid;
  gap: 0.75rem;
  margin: 1rem 0 1.5rem;
  padding: 1rem;
  border: 1px solid var(--sage);
  background: var(--paper);
}

.canary-control h2,
.canary-control p {
  margin: 0;
}

.canary-control form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.75rem;
}

.canary-control label {
  display: grid;
  gap: 0.35rem;
  font-weight: 700;
}

.canary-control input {
  min-height: 44px;
  padding: 0.55rem 0.7rem;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--sage-dark);
  border-radius: 3px;
  font: inherit;
}

.canary-control button:disabled {
  cursor: wait;
  opacity: 0.65;
}
```

Both `--paper` and `--sage-dark` already exist in
`src/web/styles/tokens.css`; do not add a new palette token.

- [ ] **Step 14: Run the component gate and commit**

Run:

```bash
npm test -- --run tests/unit/web/RunStatusPage.test.tsx --reporter=dot
npm run check
git diff --check
```

Expected: all commands exit `0`.

Commit:

```bash
git add src/web/pages/RunStatusPage.tsx src/web/styles/global.css tests/unit/web/RunStatusPage.test.tsx
git commit -m "feat: add authenticated canary control"
```

---

### Task 2: Verify, deploy, and run one preview canary

**Files:**
- Verify: `src/web/pages/RunStatusPage.tsx`
- Verify: `tests/unit/web/RunStatusPage.test.tsx`
- Operational record: `.superpowers/sdd/2026-08-02-research-ai-discovery/progress.md` (ignored; update with `apply_patch` only)

**Interfaces:**
- Consumes: the authenticated Run Status form from Task 1.
- Consumes: preview Worker `optimist-briefing-preview`, Workflow `daily-briefing-preview`, and D1 database `823bdf63-e52b-4e66-aa83-99523a6241d6`.
- Produces: one new Workflow instance on an unused edition date, plus verified D1 diagnostics, editorial status, and cost accounting.

- [ ] **Step 1: Run the full local verification gate**

Run application tests and typecheck in parallel when supported:

```bash
npm test -- --reporter=dot
npm run check
```

Then run:

```bash
npm run test:worker -- --reporter=dot
npm run evaluate
npm run build
git diff --check
```

Expected: every command exits `0`; no test failures; production assets are
present in `dist`.

- [ ] **Step 2: Confirm preview configuration and an unused canary date**

Read the temporary preview configuration without reading any secret, then run:

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT edition_date, id, status FROM workflow_runs ORDER BY edition_date DESC"
```

Choose `2026-08-01` only if the query still confirms that no run exists for
that date. Otherwise choose another unused past date. Do not delete or rewrite
an existing run merely to free a date.

- [ ] **Step 3: Deploy the preview with its secret preserved**

Run:

```bash
npx wrangler deploy \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --keep-vars
```

Expected: deployment succeeds, lists the existing bindings, and prints a new
Worker version ID. Do not print or inspect `OPENAI_API_KEY`.

- [ ] **Step 4: Verify the authenticated form in the preview browser**

Open or reload:

```text
https://optimist-briefing-preview.optimistindustries.workers.dev/run-status
```

Confirm through the visible DOM that:

- “Edition date” is labeled and defaults to the local date;
- “Starting a run may incur model costs.” is visible;
- “Start canary run” is enabled; and
- the existing run list still loads.

- [ ] **Step 5: Start exactly one authorized canary through the form**

Set the input to the unused date from Step 2 and press “Start canary run” once.
Verify the visible `role="status"` message contains the returned run ID and
the refreshed list shows the run as `pending` or `running`. If the UI returns a
duplicate-date alert, stop and select a newly verified unused date; do not
submit repeatedly without checking D1.

- [ ] **Step 6: Identify and monitor only the new Workflow instance**

Run:

```bash
npx wrangler workflows instances list daily-briefing-preview \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc
```

Read the one new instance ID from the list into a task-specific variable, then
poll it without starting another run:

```bash
read -r OPTIMIST_CANARY_INSTANCE_ID
npx wrangler workflows instances describe daily-briefing-preview "$OPTIMIST_CANARY_INSTANCE_ID" \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc
```

Expected: the instance reaches a terminal status. Continue monitoring through
temporary retries; do not restart it unless a separate diagnosis proves the
Workflow itself is stranded and the user authorizes another paid attempt.

- [ ] **Step 7: Verify durable editorial and cost results**

Set the exact run ID to the unused edition date selected in Step 2, then query
the run:

```bash
OPTIMIST_CANARY_RUN_ID='2026-08-01'
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT id, edition_date, status, current_step, retryable, failure_code, estimated_cost_usd FROM workflow_runs WHERE id = '$OPTIMIST_CANARY_RUN_ID'"
```

Query section coverage:

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT e.status, ee.section, COUNT(*) AS entries FROM editions e LEFT JOIN edition_entries ee ON ee.edition_id = e.id WHERE e.run_id = '$OPTIMIST_CANARY_RUN_ID' GROUP BY e.status, ee.section ORDER BY ee.section"
```

Query source diagnostics from the run-status API in the authenticated browser
or from the bounded `discovery_diagnostics` audit event. Confirm at minimum the
outcomes and discovered counts for arXiv, OpenAlex, Semantic Scholar, Alignment
Forum, Papers with Code, WYPR, WTOP, Maryland Matters, and Baltimore Brew.

Query reservation reconciliation:

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT status, COUNT(*) AS reservations, ROUND(SUM(estimated_cost_usd), 6) AS cost FROM model_budget_reservations WHERE run_id = '$OPTIMIST_CANARY_RUN_ID' GROUP BY status ORDER BY status"
```

Expected: no `reserved` reservation remains after the terminal Workflow state.
Publication may still fail closed if grounding or minimum coverage is not met;
that is an editorial outcome, not permission to weaken a gate.

- [ ] **Step 8: Update the operational ledger and report**

Use `apply_patch` to append the deployed Worker version, Workflow instance ID,
terminal status, source-family outcomes, edition sections, rejection reasons,
and total recorded cost to
`.superpowers/sdd/2026-08-02-research-ai-discovery/progress.md`.

Run final read-only checks:

```bash
git status --short
git log -3 --oneline
```

Report the verified result without claiming publication if the edition remains
draft or failed. If Task 2 required no tracked changes, do not create an empty
commit.
