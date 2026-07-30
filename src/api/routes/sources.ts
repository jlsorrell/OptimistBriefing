import type { Hono } from "hono";

import {
  CreateSourceInputSchema,
  RepositoryValidationError,
  SourceAlreadyExistsError,
  SourceIdAlreadyExistsError,
  UpdateSourceInputSchema,
  type UpdateSourceInput,
} from "../../db/repository";
import type { AppDependencies, AppEnv } from "../app";
import { ValidationError } from "../errors";

function sourceConflictResponse(context: {
  json: (
    body: {
      error: {
        code: "SOURCE_ALREADY_EXISTS" | "SOURCE_ID_ALREADY_EXISTS";
        message: string;
      };
    },
    status: 409,
  ) => Response;
}, error: SourceAlreadyExistsError | SourceIdAlreadyExistsError): Response {
  return context.json(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    409,
  );
}

export function registerSourceRoutes(
  app: Hono<AppEnv>,
  dependencies: AppDependencies,
): void {
  app.get("/api/sources", async (context) =>
    context.json(await dependencies.repository.listSources()));

  app.post("/api/sources", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const parsed = CreateSourceInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError();
    }
    try {
      return context.json(
        await dependencies.repository.createSource(parsed.data),
        201,
      );
    } catch (error) {
      if (error instanceof SourceAlreadyExistsError) {
        return sourceConflictResponse(context, error);
      }
      if (error instanceof SourceIdAlreadyExistsError) {
        return sourceConflictResponse(context, error);
      }
      if (error instanceof RepositoryValidationError) {
        throw new ValidationError();
      }
      throw error;
    }
  });

  app.put("/api/sources/:sourceId", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const parsed = UpdateSourceInputSchema.refine(
      (value) => Object.keys(value).length > 0,
    ).safeParse(body);
    if (!parsed.success) {
      throw new ValidationError();
    }
    try {
      const sourceId = context.req.param("sourceId");
      const update = parsed.data as UpdateSourceInput;
      const updated = await dependencies.repository.updateSource(
        sourceId,
        update,
        context.var.user.email,
      );
      return context.json(updated);
    } catch (error) {
      if (error instanceof SourceAlreadyExistsError) {
        return sourceConflictResponse(context, error);
      }
      if (error instanceof SourceIdAlreadyExistsError) {
        return sourceConflictResponse(context, error);
      }
      if (error instanceof RepositoryValidationError) {
        throw new ValidationError();
      }
      throw error;
    }
  });
}
