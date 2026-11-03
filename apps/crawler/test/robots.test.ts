import { describe, it, expect } from "vitest";
import { parseRobots, checkRobots } from "../src/crawl/robots";

const UA = "kids-event-hub-crawler";

describe("parseRobots / checkRobots", () => {
  it("該当パスが Disallow なら許可しない", () => {
    const robots = parseRobots(["User-agent: *", "Disallow: /private/", "Crawl-delay: 5"].join("\n"));
    expect(checkRobots(robots, "/private/events.pdf", UA)).toEqual({ allowed: false, crawlDelaySec: 5, rule: "Disallow: /private/" });
    expect(checkRobots(robots, "/event/list.html", UA)).toEqual({ allowed: true, crawlDelaySec: 5, rule: null });
  });

  it("自分の UA 向けのグループがあればそちらを優先する（* は使わない）", () => {
    const robots = parseRobots(
      ["User-agent: *", "Disallow: /", "", "User-agent: kids-event-hub-crawler", "Disallow: /admin"].join("\n"),
    );
    expect(checkRobots(robots, "/event/", UA).allowed).toBe(true);
    expect(checkRobots(robots, "/admin/x", UA).allowed).toBe(false);
  });

  it("Allow と Disallow は最長一致。同じ長さなら Allow", () => {
    const robots = parseRobots(["User-agent: *", "Disallow: /docs/", "Allow: /docs/event/"].join("\n"));
    expect(checkRobots(robots, "/docs/event/a.pdf", UA).allowed).toBe(true);
    expect(checkRobots(robots, "/docs/other.pdf", UA).allowed).toBe(false);
  });

  it("* と $ のパターンを扱う", () => {
    const robots = parseRobots(["User-agent: *", "Disallow: /*.pdf$", "Disallow: /search*q="].join("\n"));
    expect(checkRobots(robots, "/files/flyer.pdf", UA).allowed).toBe(false);
    expect(checkRobots(robots, "/files/flyer.pdf?x=1", UA).allowed).toBe(true);
    expect(checkRobots(robots, "/search?q=abc", UA).allowed).toBe(false);
  });

  it("空の Disallow・コメント・複数 User-agent 行のグループ", () => {
    const robots = parseRobots(
      ["# comment", "User-agent: Googlebot", "User-agent: *", "Disallow:   # 何も禁止しない"].join("\n"),
    );
    expect(checkRobots(robots, "/anything", UA)).toEqual({ allowed: true, crawlDelaySec: null, rule: null });
  });

  it("robots.txt がない（null）なら許可", () => {
    expect(checkRobots(null, "/x", UA)).toEqual({ allowed: true, crawlDelaySec: null, rule: null });
  });
});
