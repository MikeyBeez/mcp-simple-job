// dates.js — extract dates from a fetched page, so a claim can be dated.
//
// A PAGE WITHOUT A DATE CANNOT SUPPORT THE WORD "NEW".
// Live failure 2026-08-23, and it is the reason this file exists: asked "what's new in
// AI?", ornith searched, read three aggregator pages, and reported Gemini 3, GPT-5.1 and
// Claude Opus 4.5 as that month's news. Every one was real. Every one was nine months
// old. Nothing was invented and nothing was miscited -- the citation check passed
// cleanly, because a stale bullet is the right length, is not a copy, and carries a
// valid page number. The material simply never said WHEN, and no one in the chain asked.
//
// Same shape as the numbered-pages fix in index.js: do it in code, not in the prompt.
// Dates are extracted here, shown to the model in the page header, demanded back in
// every bullet, and counted on the way out. A model asked politely for dates will
// supply plausible ones; a model handed them and range-checked cannot.
//
// Separate module rather than inline so it can be unit-tested: index.js starts the MCP
// server at import time, so anything defined in it is unreachable from a test.

export const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

const M = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const mm = (name) => MONTHS[name.slice(0, 3).toLowerCase()];
const pad = (d) => String(d).padStart(2, '0');

export const DATE_PATTERNS = [
  // ISO, and the yyyy/mm/dd that most CMS urls use
  [/\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/g, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  // "August 13, 2026" / "Aug 13 2026"
  [new RegExp(`\\b(${M})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, 'gi'), (m) => `${m[3]}-${mm(m[1])}-${pad(m[2])}`],
  // "13 August 2026"
  [new RegExp(`\\b(\\d{1,2})\\s+(${M})[a-z]*\\.?,?\\s+(20\\d{2})\\b`, 'gi'), (m) => `${m[3]}-${mm(m[2])}-${pad(m[1])}`],
  // month + year only, e.g. an "august-2026" slug -- day unknown, so the 1st
  [new RegExp(`\\b(${M})[a-z]*[-\\s](20\\d{2})\\b`, 'gi'), (m) => `${m[2]}-${mm(m[1])}-01`],
];

/**
 * Every plausible date in a string: ISO, de-duplicated, sorted ascending.
 * `today` is injectable so the tests do not drift as the calendar moves.
 */
export function datesIn(text, today = new Date().toISOString().slice(0, 10)) {
  const out = new Set();
  // PATTERNS ARE ORDERED MOST-SPECIFIC FIRST, AND EACH ONE CONSUMES WHAT IT MATCHED.
  // Without that, "13 August 2026" matches the day-month-year pattern AND the loose
  // month-year fallback, yielding both 2026-08-13 and 2026-08-01 -- one real date and
  // one phantom, from a string containing a single date. Caught by the first unit test
  // written against this file. Blanking the matched span (rather than deleting it)
  // keeps every later index valid.
  let rest = String(text || '');
  for (const [re, fmt] of DATE_PATTERNS) {
    const spans = [];
    for (const m of rest.matchAll(re)) {
      const iso = fmt(m);
      // A future date is a version number, a copyright range or a typo, never a
      // publication date. 1990 is the floor for the same reason in reverse.
      if (iso >= '1990-01-01' && iso <= today) out.add(iso);
      // Consumed either way: a rejected 2027 must not fall through to a looser
      // pattern and come back as 2027-01-01.
      spans.push([m.index, m.index + m[0].length]);
    }
    for (const [s, e] of spans.reverse())
      rest = rest.slice(0, s) + ' '.repeat(e - s) + rest.slice(e);
  }
  return [...out].sort();
}

/**
 * What this page can support a date claim with.
 *   published      best guess at the page's own date: the url first (a url date is put
 *                  there by the publisher and cannot be a date the article merely
 *                  mentions), then the head of the text -- but ONLY when the head holds
 *                  exactly one date.
 *
 *                  That last condition is the whole trick, and a unit test found it.
 *                  One date at the top of a page is a byline. SEVERAL dates at the top
 *                  is a LIST, and the first is an item in it, not the page's own date.
 *                  The 2026-08-23 failure was exactly this shape: an aggregator whose
 *                  opening lines named four model releases with four dates. Taking the
 *                  first would have stamped the page "published 2025-11-24" on no
 *                  evidence -- a confident wrong date, which is worse than no date,
 *                  because the caller stops looking.
 *   oldest/newest  the range of dates anywhere on the page. An aggregator listing a
 *                  year of releases is honestly described by its range, not by one
 *                  date -- and a page whose newest date is nine months old is visibly
 *                  stale here even when nothing on it says so.
 *   found          how many distinct dates were seen at all. Zero means undated.
 */
export function pageDating(p, today = new Date().toISOString().slice(0, 10)) {
  const fromUrl  = datesIn(p.url || '', today);
  const fromHead = datesIn(String(p.text || '').slice(0, 3000), today);
  const all      = datesIn(`${p.url || ''}\n${p.text || ''}`, today);
  const published = fromUrl[fromUrl.length - 1] || (fromHead.length === 1 ? fromHead[0] : null);
  return { published, oldest: all[0] || null, newest: all[all.length - 1] || null, found: all.length };
}

/** One line for the page header the model reads. */
export function dateLine(d) {
  return d.published ? `dated ${d.published}`
       : d.newest    ? `no publication date; dates mentioned on the page run ${d.oldest} to ${d.newest}`
                     : 'UNDATED — this page carries no date at all';
}
