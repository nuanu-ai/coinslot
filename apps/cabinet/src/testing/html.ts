/**
 * A page read the way a person reads it, with the markup taken out.
 *
 * The cabinet's tests are about what a merchant can see and do, not about
 * class names, so what they assert against is the text of the page rather than
 * its tags. This is how that text is got, and it lives here because two test
 * files wanted the same thing and each had written it out — two copies of one
 * decoding order, either of which could be corrected without the other.
 *
 * The order is the decision in it. Entities are decoded after the tags are
 * stripped, and the ampersand last of all: decoded first, a page carrying the
 * literal text `&lt;` would come out as a bracket, the bracket would be
 * stripped as if it were markup, and a test would report tags on a page that
 * has none.
 */
export const readable = (html: string): string =>
  html
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();
