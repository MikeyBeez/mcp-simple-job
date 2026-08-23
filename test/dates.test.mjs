import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesIn, pageDating, dateLine } from '../dates.js';

const TODAY = '2026-08-23';

test('reads every date format that appears on a real news page', () => {
  assert.deepEqual(datesIn('published 2026-08-13', TODAY), ['2026-08-13']);
  assert.deepEqual(datesIn('August 13, 2026', TODAY),      ['2026-08-13']);
  assert.deepEqual(datesIn('Aug 13 2026', TODAY),          ['2026-08-13']);
  assert.deepEqual(datesIn('13 August 2026', TODAY),       ['2026-08-13']);
  assert.deepEqual(datesIn('/blog/ai-updates-august-2026', TODAY), ['2026-08-01']);
  assert.deepEqual(datesIn('https://x.com/2026/08/13/post', TODAY), ['2026-08-13']);
});

test('sorts, de-duplicates, and never returns a future date', () => {
  assert.deepEqual(datesIn('2026-08-13 and August 13, 2026 and 2025-11-02', TODAY),
                   ['2025-11-02', '2026-08-13']);
  // a future date is a version number or a copyright range, not a publication date
  assert.deepEqual(datesIn('roadmap for 2027-01-01', TODAY), []);
  assert.deepEqual(datesIn('since 1889-04-01', TODAY), []);
});

test('the url wins over the body, because the publisher put it there', () => {
  const d = pageDating({ url: 'https://x.com/2026/08/13/post',
                         text: 'A retrospective on GPT-5.1, released November 12, 2025.' }, TODAY);
  assert.equal(d.published, '2026-08-13');
  assert.equal(d.oldest, '2025-11-12');   // the mentioned date is still visible as range
  assert.equal(d.newest, '2026-08-13');
});

test('falls back to the head of the text when the url carries no date', () => {
  const d = pageDating({ url: 'https://x.com/latest', text: 'Posted August 5, 2026. Body...' }, TODAY);
  assert.equal(d.published, '2026-08-05');
});

test('THE REGRESSION: an undated page full of stale dates is reported as stale', () => {
  // This is the 2026-08-23 failure. The page has no publication date and everything on
  // it is nine months old. Before this module, the reply carried no signal at all.
  const d = pageDating({ url: 'https://aggregator.example/ai-news',
                         text: 'Gemini 3 topped LMArena. GPT-5.1 shipped. ' +
                               'Claude Opus 4.5 released November 24, 2025. Grok 4.1 on 2025-11-17.' }, TODAY);
  assert.equal(d.published, null, 'no publication date should be claimed');
  assert.equal(d.newest, '2025-11-24');
  assert.ok(d.newest < '2026-01-01', 'the newest thing on the page is from last year');
  assert.match(dateLine(d), /no publication date; dates mentioned on the page run/);
});

test('a genuinely undated page says so', () => {
  const d = pageDating({ url: 'https://x.com/about', text: 'We build things.' }, TODAY);
  assert.deepEqual(d, { published: null, oldest: null, newest: null, found: 0 });
  assert.match(dateLine(d), /UNDATED/);
});
