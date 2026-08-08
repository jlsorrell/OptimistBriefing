import { describe, expect, it } from "vitest";

import {
  boundProviderTextDetailed,
  decodeProviderTextEntities,
  normalizeProviderText,
  normalizeProviderTextDetailed,
  truncateProviderTextAtCodePointBoundary,
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

  it("keeps the standalone decoder free of compatibility folding", () => {
    expect(decodeProviderTextEntities("＆#8217;")).toBe("＆#8217;");
    expect(decodeProviderTextEntities("&#65308;br&#65310;")).toBe(
      "＜br＞",
    );
  });

  it("folds compatibility syntax inside exactly two normalization decode passes", () => {
    expect(normalizeProviderText("＆#8217;")).toBe("’");
    expect(normalizeProviderText("＆amp;#8217;")).toBe("’");
    expect(normalizeProviderText("&amp;amp;#8217;")).toBe("&#8217;");
    expect(normalizeProviderTextDetailed("＆#8217;")).toEqual({
      value: "’",
      truncated: false,
    });
  });

  it("strips tags only after final compatibility folding", () => {
    expect(normalizeProviderText("&#65308;br&#65310;", {
      stripHtml: true,
    })).toBeNull();
    expect(normalizeProviderText(
      "&#65308;script&#65310;safe text&#65308;/script&#65310;",
      { stripHtml: true },
    )).toBe("safe text");
    expect(normalizeProviderText(
      "Evidence &#65308;em&#65310;remains&#65308;/em&#65310; useful.",
      { stripHtml: true },
    )).toBe("Evidence remains useful.");
    expect(normalizeProviderText("&#65308;br&#65310;")).toBe("<br>");
  });

  it("strips compatibility tags formed by the second and final decode pass", () => {
    expect(normalizeProviderText(
      "&amp;#65308;br&amp;#65310;",
      { stripHtml: true },
    )).toBeNull();
    expect(normalizeProviderText(
      "&amp;#65308;script&amp;#65310;safe final text&amp;#65308;/script&amp;#65310;",
      { stripHtml: true },
    )).toBe("safe final text");
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

  it("bounds undecoded provider text after NFKC expansion", () => {
    const bounded = boundProviderTextDetailed("ﬃ".repeat(500), {
      maxCharacters: 500,
    });

    expect(bounded.value).toHaveLength(500);
    expect(bounded.truncated).toBe(true);
  });

  it("safely truncates assessment text without decoding entities", () => {
    for (const maximum of [4_000, 100_000]) {
      const value = `${"a".repeat(maximum - 1)}😀tail &amp;`;
      const truncated = truncateProviderTextAtCodePointBoundary(
        value,
        maximum,
      );

      expect(truncated).toHaveLength(maximum - 1);
      expect(truncated).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(truncated).not.toContain("&");
    }
  });

  it.each([
    {
      name: "lone low surrogate at boundary",
      value: "a\uDC00",
      maximum: 2,
      expected: "a",
    },
    {
      name: "lone low surrogate in the interior",
      value: "a\uDC00b",
      maximum: 3,
      expected: "ab",
    },
    {
      name: "lone high surrogate at exact length",
      value: "a\uD800",
      maximum: 2,
      expected: "a",
    },
    {
      name: "valid pair within the bound",
      value: "a😀b",
      maximum: 3,
      expected: "a😀",
    },
    {
      name: "pair split by the bound",
      value: "a😀b",
      maximum: 2,
      expected: "a",
    },
    { name: "zero bound", value: "😀", maximum: 0, expected: "" },
  ])("sanitizes $name", ({ value, maximum, expected }) => {
    const truncated = truncateProviderTextAtCodePointBoundary(value, maximum);

    expect(truncated).toBe(expected);
    expect(truncated.length).toBeLessThanOrEqual(maximum);
    expect(truncated).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("does not inspect code units beyond the truncation bound", () => {
    const originalCharCodeAt = String.prototype.charCodeAt;
    const inspected: number[] = [];
    String.prototype.charCodeAt = function(index: number): number {
      inspected.push(index);
      return originalCharCodeAt.call(this, index);
    };
    try {
      expect(truncateProviderTextAtCodePointBoundary("ab😀tail", 2)).toBe(
        "ab",
      );
    } finally {
      String.prototype.charCodeAt = originalCharCodeAt;
    }

    expect(inspected.length).toBeGreaterThan(0);
    expect(Math.max(...inspected)).toBeLessThan(2);
  });
});
