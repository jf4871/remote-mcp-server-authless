import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import ICAL from 'ical.js';

const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, ''))
  .replace('export default', 'globalThis.worker =');
const context = vm.createContext({ICAL});
vm.runInContext(executable, context);
const parse = body => JSON.parse(JSON.stringify(context.calendarFromIcs(body)));
const calendar = (...components) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...components, 'END:VCALENDAR'].join('\r\n');
const event = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
let passed = 0;
function check(name, test) { test(); passed++; console.log(`PASS: ${name}`); }

check('Empty ICS is a successful empty calendar', () => {
  assert.equal(parse(calendar()).eventCount, 0);
});
check('UTC, duration, text escaping and folded lines', () => {
  const result = parse(calendar(event('UID:utc', 'DTSTART:20261015T080000Z', 'DURATION:PT90M',
    'SUMMARY:Test\\, med semikolon\\; og æøå', 'DESCRIPTION:Linje 1\\nLinje 2',
    'LOCATION:Et meget langt', '  lokale')));
  const e = result.events[0];
  assert.equal(e.title, 'Test, med semikolon; og æøå');
  assert.equal(e.start.utc, '2026-10-15T08:00:00.000Z');
  assert.equal(e.end.utc, '2026-10-15T09:30:00.000Z');
  assert.equal(e.description, 'Linje 1\nLinje 2');
  assert.equal(e.location, 'Et meget langt lokale');
  assert.equal(e.allDay, false);
});
check('All-day default end is exclusive next date', () => {
  const e = parse(calendar(event('UID:day', 'DTSTART;VALUE=DATE:20261015'))).events[0];
  assert.equal(e.start.value, '2026-10-15');
  assert.equal(e.end.value, '2026-10-16');
  assert.equal(e.start.utc, null);
  assert.equal(e.allDay, true);
});
check('Floating dates do not acquire an invented UTC timezone', () => {
  const e = parse(calendar(event('UID:float', 'DTSTART:20261015T090000'))).events[0];
  assert.equal(e.start.value, '2026-10-15T09:00:00');
  assert.equal(e.start.timeZone, 'floating');
  assert.equal(e.start.utc, null);
  assert.equal(e.end.value, e.start.value);
});
check('Unknown timezone is preserved without false conversion', () => {
  const e = parse(calendar(event('UID:unknown', 'DTSTART;TZID=Custom/Unknown:20261015T090000'))).events[0];
  assert.equal(e.start.timeZone, 'Custom/Unknown');
  assert.equal(e.start.utc, null);
});
const zone = ['BEGIN:VTIMEZONE','TZID:Europe/Copenhagen','BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0100','TZOFFSETTO:+0200','END:DAYLIGHT','BEGIN:STANDARD',
  'DTSTART:19701025T030000','RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0200','TZOFFSETTO:+0100','END:STANDARD','END:VTIMEZONE'].join('\r\n');
check('Embedded Copenhagen timezone respects summer and winter time', () => {
  const es = parse(calendar(zone,
    event('UID:summer', 'DTSTART;TZID=Europe/Copenhagen:20261015T090000'),
    event('UID:winter', 'DTSTART;TZID=Europe/Copenhagen:20261115T090000'))).events;
  assert.equal(es[0].start.utc, '2026-10-15T07:00:00.000Z');
  assert.equal(es[1].start.utc, '2026-11-15T08:00:00.000Z');
});
check('Recurring series, exclusions, extra dates, moved and cancelled exceptions survive', () => {
  const result = parse(calendar(
    event('UID:series', 'DTSTART:20261015T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TH',
      'EXDATE:20261022T090000Z,20261029T090000Z', 'RDATE:20261016T090000Z'),
    event('UID:series', 'RECURRENCE-ID:20261105T090000Z', 'DTSTART:20261105T110000Z'),
    event('UID:series', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261112T090000Z',
      'DTSTART:20261112T090000Z', 'STATUS:CANCELLED')));
  assert.equal(result.recurrenceExpanded, false);
  assert.equal(result.eventCount, 3);
  assert.deepEqual(result.events[0].recurrence.rules, ['FREQ=WEEKLY;BYDAY=TH']);
  assert.equal(result.events[0].recurrence.excludedDates.length, 2);
  assert.equal(result.events[0].recurrence.additionalDates[0].value, '2026-10-16T09:00:00Z');
  assert.equal(result.events[1].recurrence.recurrenceId.value, '2026-11-05T09:00:00Z');
  assert.equal(result.events[2].status, 'CANCELLED');
  assert.equal(result.events[2].recurrence.range, 'THISANDFUTURE');
});
check('Period-valued extra dates retain their duration', () => {
  const e = parse(calendar(event('UID:period','DTSTART:20261015T090000Z',
    'RDATE;VALUE=PERIOD:20261016T090000Z/PT2H'))).events[0];
  assert.equal(e.recurrence.additionalDates[0].end.utc, '2026-10-16T11:00:00.000Z');
});
check('A second calendar does not inherit another feed timezone', () => {
  const e = parse(calendar(event('UID:isolated', 'DTSTART;TZID=Europe/Copenhagen:20261015T090000'))).events[0];
  assert.equal(e.start.utc, null);
});
check('Invalid event fails instead of silently disappearing', () => {
  assert.throws(() => parse(calendar(event('UID:missing-start', 'SUMMARY:Invalid'))));
});
check('Oversized calendars fail explicitly', () => {
  assert.throws(() => parse(' '.repeat(5_000_001)));
  assert.throws(() => parse(calendar(...Array.from({length:5001},(_,i)=>event(`UID:${i}`,'DTSTART:20261015T090000Z')))));
});
let handler;
const liveCallbackContext = vm.createContext({ICAL, Response, Request, Headers, URL,
  McpServer:class {registerTool(name, config, callback){handler=callback;}},
  z:{object:v=>v},
  fetch:async () => new Response(calendar(event('UID:integration','DTSTART:20261015T090000Z','SUMMARY:Synthetic test'))),
  env:{PROTON_API_URL:'https://example.test/feed',PROTON_API_KEY:'SYNTHETIC_SECRET'},
});
vm.runInContext(executable+'\ncreateServer(env);', liveCallbackContext);
const response = await handler();
assert.equal(response.isError, undefined);
assert.equal(JSON.parse(response.content[0].text).events[0].title,'Synthetic test');
assert.ok(!JSON.stringify(response).includes('SYNTHETIC_SECRET'));
passed++;
console.log('PASS: Real tool callback returns normalized ICS instead of format error');
console.log(`${passed} ICS checks passed using synthetic calendars only.`);
