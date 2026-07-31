import type { Hono } from "hono";
import { z } from "zod";

import {
  FeedbackActionSchema,
  FeedbackReasonSchema,
  RepositoryValidationError,
} from "../../db/repository";
import type { AppDependencies, AppEnv } from "../app";
import { ValidationError } from "../errors";

const FeedbackRequestSchema = z.object({
  itemId: z.string().min(1),
  action: FeedbackActionSchema,
  reason: FeedbackReasonSchema.nullable().optional().default(null),
}).strict();

export function registerFeedbackRoutes(
  app: Hono<AppEnv>,
  dependencies: AppDependencies,
): void {
  app.post("/api/feedback", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const parsed = FeedbackRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError();
    }
    try {
      await dependencies.repository.recordFeedback(parsed.data);
    } catch (error) {
      if (error instanceof RepositoryValidationError) {
        throw new ValidationError();
      }
      throw error;
    }
    return context.json({ status: "recorded" as const }, 201);
  });
}
