// Tests for src/timestamps.ts — UTC verbatim, IST in Asia/Kolkata.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatTimestamp, newerSide } from '../src/timestamps';

test('formatTimestamp: round-trips canonical ISO UTC strings', () => {
  const r = formatTimestamp('2026-06-19T07:30:00.000Z');
  assert.equal(r.utc, '2026-06-19T07:30:00.000Z');
  // 07:30 UTC + 5:30 = 13:00 IST
  assert.equal(r.ist, '2026-06-19 13:00:00 IST');
});

test('formatTimestamp: handles a date that crosses midnight IST', () => {
  // 19:00 UTC + 5:30 = 00:30 next day IST.
  const r = formatTimestamp('2026-06-19T19:00:00.000Z');
  assert.equal(r.ist, '2026-06-20 00:30:00 IST');
});

test('formatTimestamp: midnight UTC → 05:30 IST (no "24" leak)', () => {
  const r = formatTimestamp('2026-06-19T00:00:00.000Z');
  assert.equal(r.ist, '2026-06-19 05:30:00 IST');
});

test('formatTimestamp: end of day where some Node builds emit hour="24"', () => {
  // 18:30 UTC = 24:00 / 00:00 IST. Stay 00, never 24.
  const r = formatTimestamp('2026-06-19T18:30:00.000Z');
  assert.match(r.ist, /^2026-06-20 00:00:00 IST$/);
});

test('formatTimestamp: independent of process timezone', () => {
  // We can't safely mutate process.env.TZ at runtime in Node (TZ is
  // sampled once on process startup), but we can prove the formatter
  // ignores the host by rendering a fixed UTC and asserting the IST
  // output is the spec-required +05:30 shift.
  const r = formatTimestamp('2026-01-01T12:00:00.000Z');
  assert.equal(r.ist, '2026-01-01 17:30:00 IST');
});

test('formatTimestamp: throws on empty / non-string', () => {
  assert.throws(() => formatTimestamp('' as string), TypeError);
  // @ts-expect-error — runtime guard
  assert.throws(() => formatTimestamp(undefined), TypeError);
  // @ts-expect-error — runtime guard
  assert.throws(() => formatTimestamp(123), TypeError);
});

test('formatTimestamp: throws on unparseable timestamp', () => {
  assert.throws(() => formatTimestamp('not-a-date'), RangeError);
  assert.throws(() => formatTimestamp('2026-13-99T99:99:99Z'), RangeError);
});

test('newerSide: returns "a" / "b" / "tie" based on parsed time', () => {
  const earlier = '2026-06-19T07:25:00.000Z';
  const later = '2026-06-19T07:30:00.000Z';
  assert.equal(newerSide(later, earlier), 'a');
  assert.equal(newerSide(earlier, later), 'b');
  assert.equal(newerSide(earlier, earlier), 'tie');
});

test('newerSide: NaN inputs lose to the valid side; NaN+NaN → tie', () => {
  const valid = '2026-06-19T07:30:00.000Z';
  assert.equal(newerSide('garbage', valid), 'b');
  assert.equal(newerSide(valid, 'garbage'), 'a');
  assert.equal(newerSide('garbage', 'also-garbage'), 'tie');
});
