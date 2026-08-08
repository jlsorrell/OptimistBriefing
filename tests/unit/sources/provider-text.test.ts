import { describe, expect, it } from "vitest";

import {
  boundProviderTextDetailed,
  decodeProviderTextEntities,
  normalizeProviderText,
  normalizeProviderTextDetailed,
  normalizedProviderSignalText,
  preparedProviderSignalText,
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

  it("removes compatibility-created tag names from bounded provider signals", () => {
    expect(normalizedProviderSignalText(
      "&#65308;technology&#65310;Ordinary update&#65308;/technology&#65310;",
      500,
    )).toBe("Ordinary update");
    expect(normalizedProviderSignalText(
      "&#65308;span&#65310;Acme launches a coding assistant&#65308;/span&#65310;",
      500,
    )).toBe("Acme launches a coding assistant");
    expect(normalizedProviderSignalText(
      "&#65308;technology&#65310;",
      500,
    )).toBeNull();
    expect(normalizedProviderSignalText(
      "&amp;amp;#65308;technology&amp;amp;#65310;Ordinary update&amp;amp;#65308;/technology&amp;amp;#65310;",
      500,
    )).toBe("Ordinary update");
    expect(normalizedProviderSignalText(
      "&amp;amp;#65308;technology&amp;amp;#65310;",
      500,
    )).toBeNull();
    expect(normalizedProviderSignalText(
      "&amp;amp;lt;span&amp;amp;gt;Useful boundary text&amp;amp;lt;/span&amp;amp;gt;",
      500,
    )).toBe("Useful boundary text");
  });

  it.each([
    {
      label: "named numeric comparison",
      raw: "3 &amp;amp;lt; 5 &amp;amp;gt; 2",
      expected: "3 &lt; 5 &gt; 2",
    },
    {
      label: "fullwidth numeric comparison",
      raw: "3 &amp;amp;#65308; 5 &amp;amp;#65310; 2",
      expected: "3 &#65308; 5 &#65310; 2",
    },
    {
      label: "unmatched closing delimiter",
      raw: "A &amp;amp;gt; C",
      expected: "A &gt; C",
    },
    {
      label: "unmatched numeric opening delimiter",
      raw: "A &amp;amp;lt; 5 C",
      expected: "A &lt; 5 C",
    },
    {
      label: "numeric token",
      raw: "A &amp;amp;lt;123&amp;amp;gt; C",
      expected: "A &lt;123&gt; C",
    },
    {
      label: "malformed name",
      raw: "A &amp;amp;lt;-tag&amp;amp;gt; C",
      expected: "A &lt;-tag&gt; C",
    },
  ])("preserves residual non-tag $label syntax", ({ raw, expected }) => {
    expect(normalizedProviderSignalText(raw, 500)).toBe(expected);
  });

  it("removes residual plausible tag syntax from visible signals", () => {
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt;span&amp;amp;gt; B &amp;amp;lt;/span&amp;amp;gt; C",
      500,
    )).toBe("A B C");
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt;br/&amp;amp;gt; B",
      500,
    )).toBe("A B");
    expect(normalizedProviderSignalText(
      "A &amp;amp;#x00003c;x-item_2.foo:bar/&amp;amp;#x00003e; B",
      500,
    )).toBe("A B");
    expect(normalizedProviderSignalText(
      "&amp;amp;lt;/technology&amp;amp;gt;",
      500,
    )).toBeNull();
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt;tag &amp;amp;lt; B &amp;amp;gt; C",
      500,
    )).toBe("A C");
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt; tag&amp;amp;gt; C",
      500,
    )).toBe("A C");
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt; /tag extra&amp;amp;gt; C",
      500,
    )).toBe("A C");
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt;span class=&quot;technology&quot;&amp;amp;gt; C",
      500,
    )).toBe("A C");
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt;span data-place=Baltimore&amp;amp;gt; C",
      500,
    )).toBe("A C");
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt;span data-note=&quot;artificial intelligence regulation&quot;&amp;amp;gt; C",
      500,
    )).toBe("A C");
    expect(normalizedProviderSignalText(
      "A &amp;amp;lt;technology class=x",
      500,
    )).toBe("A");
    expect(normalizedProviderSignalText(
      "&amp;amp;lt;technology class=x&amp;amp;gt;",
      500,
    )).toBeNull();
    expect(normalizedProviderSignalText(
      "&amp;amp;lt;span data-place=Virginia&amp;amp;gt;Baltimore transit update&amp;amp;lt;/span&amp;amp;gt;",
      500,
    )).toBe("Baltimore transit update");
  });

  it("extracts prepared provider signals without another text decode", () => {
    expect(preparedProviderSignalText(
      "&lt;technology class=x&gt;Ordinary update",
    )).toBe("Ordinary update");
    expect(preparedProviderSignalText(
      "&lt;span data-place=Baltimore&gt;Ordinary update",
    )).toBe("Ordinary update");
    expect(preparedProviderSignalText(
      "&amp;lt;technology class=x&amp;gt;Ordinary update",
    )).toBe("&amp;lt;technology class=x&amp;gt;Ordinary update");
    expect(preparedProviderSignalText(
      "3 &lt; 5 &gt; 2",
    )).toBe("3 &lt; 5 &gt; 2");
    expect(preparedProviderSignalText(
      "A &lt;\t/span data-place=Baltimore&gt; C",
    )).toBe("A C");
    expect(preparedProviderSignalText(
      "A &lt;\u00a0span data-place=Baltimore&gt; C",
    )).toBe("A C");
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
