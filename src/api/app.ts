import { Hono } from "hono";

import type { BriefingRepository } from "../db/repository";
import { EditionSchema } from "../contracts/editorial";
import { decodeEditionCursor } from "../pagination/edition-cursor";
import { readerCalendarDate } from "../time/calendar-date";
import {
  WorkflowResumeUnavailableError,
  WorkflowRunAlreadyExistsError,
} from "../workflow/run-editorial-pipeline";
import {
  ApiError,
  AuthenticationRequiredError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
  jsonError,
} from "./errors";
import { registerArchiveRoutes } from "./routes/archive";
import { registerFeedbackRoutes } from "./routes/feedback";
import { registerPreferenceRoutes } from "./routes/preferences";
import { registerRunRoutes } from "./routes/runs";
import { registerSourceRoutes } from "./routes/sources";

export type AuthenticatedUser = {
  email: string;
};

export type AuthVerifier = (token: string) => Promise<AuthenticatedUser>;

export interface WorkflowLauncher {
  start(input: {
    editionDate: string;
    actorEmail?: string;
  }): Promise<{ runId: string }>;
  resume(input: { runId: string; actorEmail?: string }): Promise<void>;
}

export type AppDependencies = {
  repository: BriefingRepository;
  authVerifier: AuthVerifier;
  workflow: WorkflowLauncher | null;
  now?: () => Date;
};

export type AppEnv = {
  Variables: {
    user: AuthenticatedUser;
  };
};

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const now = dependencies.now ?? (() => new Date());

  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return jsonError(context, error);
    }
    return jsonError(context, new InternalError());
  });

  app.notFound((context) => jsonError(context, new NotFoundError()));

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.use("/api/*", async (context, next) => {
    const assertion = context.req.header("CF-Access-Jwt-Assertion");
    if (assertion === undefined || assertion.length === 0) {
      throw new AuthenticationRequiredError();
    }

    try {
      context.set("user", await dependencies.authVerifier(assertion));
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw error;
      }
      throw new AuthenticationRequiredError();
    }

    await next();
  });

  registerFeedbackRoutes(app, dependencies);
  registerPreferenceRoutes(app, dependencies);
  registerArchiveRoutes(app, dependencies);
  registerRunRoutes(app, dependencies);
  registerSourceRoutes(app, dependencies);

  app.get("/api/edition/latest", async (context) => {
    const edition = await dependencies.repository.getLatestEdition(
      readerCalendarDate(now()),
    );
    if (edition === null) {
      throw new NotFoundError();
    }
    return context.json(edition);
  });

  app.get("/api/editions", async (context) => {
    const rawLimit = context.req.query("limit");
    const limit =
      rawLimit === undefined
        ? 20
        : /^\d+$/.test(rawLimit)
          ? Number(rawLimit)
          : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ValidationError();
    }

    const cursor = context.req.query("cursor") ?? null;
    if (cursor !== null) {
      try {
        decodeEditionCursor(cursor);
      } catch {
        throw new ValidationError();
      }
    }

    return context.json(
      await dependencies.repository.listEditions({
        limit,
        cursor,
        editionDateNotAfter: readerCalendarDate(now()),
      }),
    );
  });

  app.get("/api/editions/:editionDate", async (context) => {
    const parsedDate = EditionSchema.shape.editionDate.safeParse(
      context.req.param("editionDate"),
    );
    if (!parsedDate.success) {
      throw new ValidationError();
    }
    const edition = await dependencies.repository.getEditionByDate(
      parsedDate.data,
    );
    if (edition === null) {
      throw new NotFoundError();
    }
    return context.json(edition);
  });

  app.post("/api/admin/runs", async (context) => {
    if (dependencies.workflow === null) throw new NotFoundError();
    const body: unknown = await context.req.json().catch(() => null);
    const editionDate =
      typeof body === "object" && body !== null && "editionDate" in body
        ? (body as { editionDate?: unknown }).editionDate
        : undefined;
    const parsedDate = EditionSchema.shape.editionDate.safeParse(editionDate);
    if (!parsedDate.success) throw new ValidationError();
    try {
      const result = await dependencies.workflow.start({
        editionDate: parsedDate.data,
        actorEmail: context.var.user.email,
      });
      return context.json(result, 202);
    } catch (error) {
      if (error instanceof WorkflowRunAlreadyExistsError) {
        return context.json(
          { error: { code: "RUN_ALREADY_EXISTS", message: "A run already exists for this edition date." } },
          409,
        );
      }
      throw error;
    }
  });

  app.post("/api/admin/runs/:runId/resume", async (context) => {
    if (dependencies.workflow === null) throw new NotFoundError();
    const runId = context.req.param("runId");
    if (runId.length === 0) throw new ValidationError();
    try {
      await dependencies.workflow.resume({
        runId,
        actorEmail: context.var.user.email,
      });
      return context.body(null, 202);
    } catch (error) {
      if (error instanceof WorkflowResumeUnavailableError) {
        throw new ValidationError();
      }
      throw error;
    }
  });

  return app;
}
