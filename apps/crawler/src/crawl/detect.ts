import type { SOURCE_TYPES } from "@kids-event-hub/db";

export type DetectedType = Exclude<(typeof SOURCE_TYPES)[number], "llm">;

const EVENT_TYPE_RE = /"@type"\s*:\s*(?:\[[^\]]*)?"[A-Za-z]*Event"/;

/** 取得した文書の種別を Content-Type → URL → 本文の順に判定する */
export function detectType(doc: { contentType: string | null; url: string; body: string }): DetectedType {
  const ct = (doc.contentType ?? "").toLowerCase().split(";")[0]!.trim();
  const path = new URL(doc.url).pathname.toLowerCase();
  const head = doc.body.slice(0, 2048).trimStart();

  if (ct === "application/pdf" || path.endsWith(".pdf") || head.startsWith("%PDF")) return "pdf";
  if (ct === "text/calendar" || path.endsWith(".ics") || head.startsWith("BEGIN:VCALENDAR")) return "ical";
  if (/^application\/(rss|atom)\+xml$/.test(ct) || /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/.test(head)) return "rss";
  if (hasEventJsonLd(doc.body)) return "jsonld";
  return "html";
}

export function jsonLdBlocks(html: string): string[] {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  return [...html.matchAll(re)].map((m) => m[1]!);
}

function hasEventJsonLd(html: string): boolean {
  return jsonLdBlocks(html).some((b) => EVENT_TYPE_RE.test(b));
}
