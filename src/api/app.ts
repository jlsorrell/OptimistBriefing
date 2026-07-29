import { Hono } from "hono";

import type { BriefingRepository } from "../db/repository";
import { EditionSchema } from "../contracts/editorial";
import { decodeEditionCursor } from "../pagination/edition-cursor";
import {
  ApiError,
  AuthenticationRequiredError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
  jsonError,
} from "./errors";

export type AuthenticatedUser = {
  email: string;
};

export type AuthVerifier = (token: string) => Promise<AuthenticatedUser>;

export interface WorkflowLauncher {
  start(input: { editionDate: string }): Promise<{ runId: string }>;
  resume(input: { runId: string }): Promise<void>;
}

export type AppDependencies = {
  repository: BriefingRepository;
  authVerifier: AuthVerifier;
  workflow: WorkflowLauncher | null;
};

export type AppEnv = {
  Variables: {
    user: AuthenticatedUser;
  };
};

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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

  app.get("/api/edition/latest", async (context) => {
    const edition = await dependencies.repository.getLatestEdition();
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
      await dependencies.repository.listEditions({ limit, cursor }),
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

  return app;
}
