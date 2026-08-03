UPDATE model_budget_reservations
SET status = 'released',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'reserved'
  AND EXISTS (
    SELECT 1
    FROM workflow_runs
    WHERE workflow_runs.id = model_budget_reservations.run_id
      AND workflow_runs.status IN (
        'retryable', 'partial', 'failed', 'published'
      )
  );
