import { describe, it, expect } from "vitest";
import { detectType } from "../src/crawl/detect";

describe("detectType", () => {
  it("Content-Type で判定する", () => {
    expect(detectType({ contentType: "application/pdf", url: "https://a.jp/x", body: "" })).toBe("pdf");
    expect(detectType({ contentType: "text/calendar; charset=utf-8", url: "https://a.jp/x", body: "" })).toBe("ical");
    expect(detectType({ contentType: "application/rss+xml", url: "https://a.jp/x", body: "" })).toBe("rss");
    expect(detectType({ contentType: "application/atom+xml", url: "https://a.jp/x", body: "" })).toBe("rss");
  });

  it("Content-Type があいまいなら URL と本文で判定する", () => {
    expect(detectType({ contentType: "application/octet-stream", url: "https://a.jp/flyer.PDF", body: "" })).toBe("pdf");
    expect(detectType({ contentType: null, url: "https://a.jp/x", body: "%PDF-1.7 ..." })).toBe("pdf");
    expect(detectType({ contentType: "text/plain", url: "https://a.jp/cal", body: "BEGIN:VCALENDAR\r\n" })).toBe("ical");
    expect(detectType({ contentType: "text/xml", url: "https://a.jp/feed", body: '<?xml version="1.0"?><rss version="2.0">' })).toBe("rss");
    expect(detectType({ contentType: "application/xml", url: "https://a.jp/feed", body: '<feed xmlns="http://www.w3.org/2005/Atom">' })).toBe("rss");
  });

  it("HTML に schema.org の Event の JSON-LD があれば jsonld、なければ html", () => {
    const withLd = '<html><script type="application/ld+json">{"@type":"Event","name":"a"}</script></html>';
    expect(detectType({ contentType: "text/html", url: "https://a.jp/", body: withLd })).toBe("jsonld");
    const otherLd = '<html><script type="application/ld+json">{"@type":"Organization"}</script></html>';
    expect(detectType({ contentType: "text/html", url: "https://a.jp/", body: otherLd })).toBe("html");
  });
});
