import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

import type { AccessLevel } from "../contracts/editorial";
import { SourceHttpClient } from "./http-client";
import {
  assertSafeOutboundUrl,
  type OutboundUrlPolicy,
} from "./outbound-url";
import {
  bodyRetrievalPermitted,
  ResearchSourceRecordSchema,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

export type PaperContentRequest = {
  source: ResearchSourceInput;
  htmlUrl: string | null;
  abstract: string;
};

export type RetrievedPaperContent = {
  accessLevel: Extract<AccessLevel, "abstract" | "full_text">;
  text: string;
};

const ARXIV_HTML_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["arxiv.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/html/"],
};

function isArxivHtmlUrl(value: string): boolean {
  try {
    assertSafeOutboundUrl(value, ARXIV_HTML_POLICY);
    return true;
  } catch {
    return false;
  }
}

export class PaperContentRetriever {
  constructor(private readonly http: SourceHttpClient) {}

  async retrieve(
    request: PaperContentRequest,
  ): Promise<RetrievedPaperContent> {
    const fallback: RetrievedPaperContent = {
      accessLevel: "abstract",
      text: request.abstract,
    };
    const source: ResearchSourceRecord =
      ResearchSourceRecordSchema.parse(request.source);
    let sourceIsArxiv = false;
    try {
      assertSafeOutboundUrl(source.canonicalUrl, {
        allowedHosts: ["arxiv.org", "export.arxiv.org"],
        allowedPorts: [""],
      });
      sourceIsArxiv = true;
    } catch {
      sourceIsArxiv = false;
    }
    if (
      !sourceIsArxiv ||
      !bodyRetrievalPermitted(source) ||
      request.htmlUrl === null ||
      !isArxivHtmlUrl(request.htmlUrl)
    ) {
      return fallback;
    }

    try {
      const response = await this.http.get(source, request.htmlUrl, {
        headers: { accept: "text/html,application/xhtml+xml" },
        useValidators: false,
        urlPolicy: ARXIV_HTML_POLICY,
      });
      if (
        response.body === null ||
        !isArxivHtmlUrl(response.finalUrl) ||
        response.contentType?.toLowerCase().includes("html") !== true
      ) {
        return fallback;
      }
      const { document } = parseHTML(response.body);
      const article = new Readability(
        document as unknown as Document,
      ).parse();
      const text = article?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (text.length < 200) {
        return fallback;
      }
      return {
        accessLevel: "full_text",
        text,
      };
    } catch {
      return fallback;
    }
  }
}
