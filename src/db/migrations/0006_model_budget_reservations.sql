CREATE TABLE model_budget_reservations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  month_start TEXT NOT NULL,
  maximum_cost_microusd INTEGER NOT NULL CHECK (maximum_cost_microusd >= 0),
  actual_cost_microusd INTEGER CHECK (actual_cost_microusd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'reconciled', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_model_budget_reservations_month
  ON model_budget_reservations (month_start, status);
