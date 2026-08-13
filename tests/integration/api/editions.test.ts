import { describe, expect, it, vi } from "vitest";

import { createApp, type WorkflowLauncher } from "../../../src/api/app";
import type {
  ArchiveSearchInput,
  BriefingRepository,
  EditionListInput,
} from "../../../src/db/repository";
import type { Edition, EditionWithEntries } from "../../../src/contracts/editorial";

const assertionHeaders = {
  "CF-Access-Jwt-Assertion": "signed-token",
};

function edition(editionDate: string): Edition {
  return {
    id: `edition-${editionDate}`,
    editionDate,
    runId: `run-${editionDate}`,
    status: "published",
    readingMinutes: 24,
    publishedAt: `${editionDate}T09:45:00.000Z`,
    createdAt: `${editionDate}T09:30:00.000Z`,
  };
}

function editionWithEntries(editionDate: string): EditionWithEntries {
  return { ...edition(editionDate), entries: [] };
}

function fakeWorkflow(): WorkflowLauncher {
  return {
    start: async () => ({ runId: "unused" }),
    resume: async () => undefined,
  };
}

function appWith(
  repository: BriefingRepository,
  now = () => new Date("2026-08-14T03:59:00.000Z"),
) {
  return createApp({
    repository,
    authVerifier: async () => ({ email: "reader@example.com" }),
    workflow: fakeWorkflow(),
    now,
  });
}

function fakeRepository(
  overrides: Partial<BriefingRepository> = {},
): BriefingRepository {
  return {
    getLatestEdition: async () => editionWithEntries("2026-07-29"),
    getEditionByDate: async () => null,
    listEditions: async () => ({ items: [], nextCursor: null }),
    ...overrides,
  } as BriefingRepository;
}

describe("edition API", () => {
  it("caps the latest edition at today's New York calendar date", async () => {
    const getLatestEdition = vi.fn(async () =>
      editionWithEntries("2026-08-13"),
    );
    const response = await appWith(
      fakeRepository({ getLatestEdition }),
    ).request("/api/edition/latest", { headers: assertionHeaders });

    expect(response.status).toBe(200);
    expect(getLatestEdition).toHaveBeenCalledWith("2026-08-13");
  });

  it("lists editions with a default limit of 20", async () => {
    const listEditions = vi.fn(async (_input: EditionListInput) => ({
      items: [edition("2026-07-29")],
      nextCursor: null,
    }));
    const response = await appWith(fakeRepository({ listEditions })).request(
      "/api/editions",
      { headers: assertionHeaders },
    );

    expect(response.status).toBe(200);
    expect(listEditions).toHaveBeenCalledWith({
      limit: 20,
      cursor: null,
      editionDateNotAfter: "2026-08-13",
    });
    await expect(response.json()).resolves.toEqual({
      items: [edition("2026-07-29")],
      nextCursor: null,
    });
  });

  it.each(["0", "51", "1.5", "ten", ""])(
    "rejects the invalid edition limit %j",
    async (limit) => {
      const response = await appWith(fakeRepository()).request(
        `/api/editions?limit=${encodeURIComponent(limit)}`,
        { headers: assertionHeaders },
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
    },
  );

  it("rejects a malformed cursor before querying the repository", async () => {
    const listEditions = vi.fn();
    const response = await appWith(fakeRepository({ listEditions })).request(
      "/api/editions?cursor=not-a-cursor",
      { headers: assertionHeaders },
    );

    expect(response.status).toBe(422);
    expect(listEditions).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("accepts an opaque base64url cursor containing the last edition date", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ editionDate: "2026-07-28" }),
    ).toString("base64url");
    const listEditions = vi.fn(async (_input: EditionListInput) => ({
      items: [edition("2026-07-27")],
      nextCursor: null,
    }));

    const response = await appWith(fakeRepository({ listEditions })).request(
      `/api/editions?cursor=${cursor}&limit=1`,
      { headers: assertionHeaders },
    );

    expect(response.status).toBe(200);
    expect(listEditions).toHaveBeenCalledWith({
      limit: 1,
      cursor,
      editionDateNotAfter: "2026-08-13",
    });
  });

  it("caps archive results at today's New York calendar date", async () => {
    const searchArchive = vi.fn(async (_input: ArchiveSearchInput) => ({
      items: [],
      nextCursor: null,
    }));
    const response = await appWith(
      fakeRepository({ searchArchive }),
    ).request("/api/archive", { headers: assertionHeaders });

    expect(response.status).toBe(200);
    expect(searchArchive).toHaveBeenCalledWith({
      query: null,
      topic: null,
      author: null,
      institution: null,
      source: null,
      section: null,
      limit: 20,
      cursor: null,
      saved: false,
      editionDateNotAfter: "2026-08-13",
    });
  });

  it("returns a published edition by date and rejects invalid dates", async () => {
    const found = editionWithEntries("2026-07-28");
    const getEditionByDate = vi.fn(async () => found);
    const app = appWith(fakeRepository({ getEditionByDate }));

    const response = await app.request("/api/editions/2026-07-28", {
      headers: assertionHeaders,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(found);

    const invalid = await app.request("/api/editions/not-a-date", {
      headers: assertionHeaders,
    });
    expect(invalid.status).toBe(422);
    expect(getEditionByDate).toHaveBeenCalledTimes(1);
  });

  it("returns not found for an unpublished edition date", async () => {
    const response = await appWith(fakeRepository()).request(
      "/api/editions/2026-07-28",
      { headers: assertionHeaders },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
