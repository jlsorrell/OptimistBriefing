import type { Hono } from "hono";
import { z } from "zod";

import {
  PreferenceUpdateInputSchema,
  RepositoryValidationError,
} from "../../db/repository";
import type { AppDependencies, AppEnv } from "../app";
import { ValidationError } from "../errors";

const RemoveAdjustmentSchema = z.object({
  removeFeedbackId: z.string().min(1),
}).strict();

export function registerPreferenceRoutes(
  app: Hono<AppEnv>,
  dependencies: AppDependencies,
): void {
  app.get("/api/preferences", async (context) =>
    context.json(await dependencies.repository.getPreferences()));

  app.put("/api/preferences", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const update = PreferenceUpdateInputSchema.safeParse(body);
    const removal = RemoveAdjustmentSchema.safeParse(body);
    if (!update.success && !removal.success) {
      throw new ValidationError();
    }
    try {
      let preferences;
      if (update.success) {
        preferences = await dependencies.repository.updatePreferences(
          update.data,
        );
      } else if (removal.success) {
        preferences =
          await dependencies.repository.removeFeedbackAdjustment(
            removal.data.removeFeedbackId,
          );
      } else {
        throw new ValidationError();
      }
      return context.json(preferences);
    } catch (error) {
      if (error instanceof RepositoryValidationError) {
        throw new ValidationError();
      }
      throw error;
    }
  });

  app.post("/api/preferences/reset", async (context) =>
    context.json(await dependencies.repository.resetPreferences()));
}
