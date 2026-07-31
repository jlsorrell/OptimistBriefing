import type { Hono } from "hono";

import { RepositoryValidationError } from "../../db/repository";
import type { AppDependencies, AppEnv } from "../app";
import { NotFoundError, ValidationError } from "../errors";

export function registerRunRoutes(
  app: Hono<AppEnv>,
  dependencies: AppDependencies,
): void {
  app.get("/api/runs", async (context) =>
    context.json(await dependencies.repository.listWorkflowRuns()));

  app.get("/api/runs/:runId", async (context) => {
    const runId = context.req.param("runId");
    if (runId.length === 0) {
      throw new ValidationError();
    }
    try {
      const run = await dependencies.repository.getWorkflowRunDetail(runId);
      if (run === null) {
        throw new NotFoundError();
      }
      return context.json(run);
    } catch (error) {
      if (error instanceof RepositoryValidationError) {
        throw new ValidationError();
      }
      throw error;
    }
  });
}
