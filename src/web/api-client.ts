import {
  EditionPageSchema,
  EditionWithEntriesSchema,
  type EditionPage,
} from "../contracts/api";
import type { EditionWithEntries } from "../contracts/editorial";

export class BriefingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BriefingApiError";
  }
}

export class BriefingApiClient {
  constructor(private readonly baseUrl = "/api") {}

  async latestEdition(signal?: AbortSignal): Promise<EditionWithEntries> {
    const response = await fetch(
      `${this.baseUrl}/edition/latest`,
      signal === undefined ? undefined : { signal },
    );
    return EditionWithEntriesSchema.parse(await this.readJson(response));
  }

  async edition(editionDate: string, signal?: AbortSignal): Promise<EditionWithEntries> {
    const response = await fetch(
      `${this.baseUrl}/editions/${encodeURIComponent(editionDate)}`,
      signal === undefined ? undefined : { signal },
    );
    return EditionWithEntriesSchema.parse(await this.readJson(response));
  }

  async editions(
    input: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<EditionPage> {
    const query = new URLSearchParams();
    if (input.cursor !== undefined) query.set("cursor", input.cursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await fetch(
      `${this.baseUrl}/editions${suffix}`,
      signal === undefined ? undefined : { signal },
    );
    return EditionPageSchema.parse(await this.readJson(response));
  }

  private async readJson(response: Response): Promise<unknown> {
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new BriefingApiError(response.status, "The briefing could not be loaded.");
    }
    return body;
  }
}
