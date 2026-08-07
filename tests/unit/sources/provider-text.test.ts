import { describe, expect, it } from "vitest";

import {
  decodeProviderTextEntities,
  normalizeProviderText,
  normalizeProviderTextDetailed,
} from "../../../src/sources/provider-text";

describe("provider text normalization", () => {
  it("decodes decimal, hexadecimal, named, and double-encoded references", () => {
    expect(decodeProviderTextEntities(
      "&#8216;safe&#8217; &#x201C;text&#x201D; &amp; &quot;ok&quot; &amp;#8217;",
    )).toBe("‘safe’ “text” & \"ok\" ’");
  });

  it("keeps unsupported and unsafe references inert", () => {
    expect(decodeProviderTextEntities(
      "&#0; &#xD800; &#x110000; &#x1F; &copy; &unfinished",
    )).toBe("&#0; &#xD800; &#x110000; &#x1F; &copy; &unfinished");
  });

  it("keeps C1 control references inert", () => {
    expect(decodeProviderTextEntities("&#128; &#x9F;")).toBe(
      "&#128; &#x9F;",
    );
  });

  it("decodes the named apos reference", () => {
    expect(decodeProviderTextEntities("it&apos;s")).toBe("it's");
  });

  it("inspects at most 100,000 input characters", () => {
    const decoded = decodeProviderTextEntities(
      `${"a".repeat(100_000)}&apos;outside`,
    );

    expect(decoded).toHaveLength(100_000);
    expect(decoded.endsWith("outside")).toBe(false);
  });

  it("does not split a surrogate pair at the input inspection bound", () => {
    const input = `${"a".repeat(99_999)}😀outside`;
    const originalIterator = String.prototype[Symbol.iterator];
    let inspectedCodeUnits = 0;
    let inspectedPastBound = false;
    let decoded = "";
    String.prototype[Symbol.iterator] = function* ():
      Generator<string, undefined, unknown> {
      for (const character of originalIterator.call(this)) {
        inspectedCodeUnits += character.length;
        if (inspectedCodeUnits > 100_000) inspectedPastBound = true;
        yield character;
      }
      return undefined;
    };
    try {
      decoded = decodeProviderTextEntities(input);
    } finally {
      String.prototype[Symbol.iterator] = originalIterator;
    }

    expect(decoded).toHaveLength(99_999);
    expect(decoded).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(inspectedPastBound).toBe(false);
  });

  it("leaves a third decode pass inert", () => {
    expect(decodeProviderTextEntities("&amp;amp;#8217;")).toBe(
      "&#8217;",
    );
  });

  it("returns bounded plain text after decoding and tag removal", () => {
    expect(normalizeProviderText(
      "&lt;script&gt;bad()&lt;/script&gt; &nbsp; useful   text",
      { stripHtml: true, maxCharacters: 20 },
    )).toBe("bad() useful text");
  });

  it("normalizes empty input to null", () => {
    expect(normalizeProviderText(" &nbsp; ")).toBeNull();
    expect(normalizeProviderText(null)).toBeNull();
  });

  it("truncates without retaining half of a surrogate pair", () => {
    const normalized = normalizeProviderText("A😀B", {
      maxCharacters: 2,
    });

    expect(normalized).toBe("A");
    expect(normalized).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("reports truncation caused by NFKC expansion", () => {
    const normalized = normalizeProviderTextDetailed("ﬃ".repeat(60_000));

    expect(normalized.value).toHaveLength(100_000);
    expect(normalized.truncated).toBe(true);
  });
});
