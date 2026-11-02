export { toHalfWidth } from "./normalize/text";
export { normalizeDate, type NormalizedDate, type NormalizeDateOptions, type Recurrence } from "./normalize/date";
export { normalizePrice, type NormalizedPrice, type PriceItem } from "./normalize/price";
export { normalizeAge, type NormalizedAge } from "./normalize/age";
export { CATEGORIES, classifyCategory, type Category } from "./normalize/category";
export {
  dedupe,
  isDuplicate,
  normalizeForCompare,
  titleSimilarity,
  TITLE_THRESHOLD,
  VENUE_THRESHOLD,
  type DedupCandidate,
} from "./dedup";
