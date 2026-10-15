import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import ICAL from 'ical.js';

const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, ''))
  .replace('export default', 'globalThis.worker =');
const marker = 'SENTINEL_DO_NOT_EXPOSE';
const fixtureEnv = {
  MCP_TOKEN: 'test-mcp-token',
  PROTON_API_KEY: marker,
  PROTON_API_URL: `https://calendar.example.test/feed?key=${marker}`,
};

function load(fetchImplementation, env = fixtureEnv) {
  let tool;
  let transportCalls = 0;
  const context = vm.createContext({
    McpServer: class { registerTool(name, config, handler) { tool = handler; } },
    z: { object: value => value },
    createMcpHandler: () => () => { transportCalls++; return new Response('mock MCP transport'); },
    fetch: fetchImplementation, Response, Request, Headers, URL, env, ICAL,
    handleCalendarOAuth: () => new Response('Unauthorized', {status:401}),
  });
  vm.runInContext(executable + '\ncreateServer(env);', context);
  return { invoke: () => tool(), worker: context.worker, transportCalls: () => transportCalls };
}

const response = (body, status = 200) => async () => new Response(body, {status});
const cases = [
  ['JSON success unchanged', response('{"events":[]}'), null],
  ['Malformed ICS hides feed data', response(`BEGIN:VCALENDAR\r\n${marker}\r\nEND:VCALENDAR\r\n`), 'CALENDAR_ICS_INVALID'],
  ['HTML detected', response('<!DOCTYPE html><html>Login</html>'), 'CALENDAR_HTML_FORMAT'],
  ['HTTP 401 distinguished', response(marker, 401), 'CALENDAR_HTTP_ERROR'],
  ['HTTP 500 distinguished', response(marker, 500), 'CALENDAR_HTTP_ERROR'],
  ['Fetch error hides credentials', async () => { throw new Error(`Request failed: ${marker}`); }, 'CALENDAR_FETCH_FAILED'],
  ['Missing URL distinguished', response('{}'), 'CALENDAR_URL_MISSING', {...fixtureEnv, PROTON_API_URL:undefined}],
  ['Invalid URL distinguished', response('{}'), 'CALENDAR_URL_INVALID', {...fixtureEnv, PROTON_API_URL:marker}],
  ['Unsupported scheme distinguished', response('{}'), 'CALENDAR_URL_SCHEME', {...fixtureEnv, PROTON_API_URL:'file:///private'}],
  ['Header error hides credentials', response('{}'), 'CALENDAR_KEY_FORMAT', {...fixtureEnv, PROTON_API_KEY:`${marker}\r\nInjected: header`}],
  ['Body-read failure distinguished', async () => ({ok:true, text:async () => {throw new Error(marker)}}), 'CALENDAR_BODY_READ_FAILED'],
  ['Malformed JSON hides response body', response(`{"secret":"${marker}"`), 'CALENDAR_INVALID_JSON'],
  ['Empty response distinguished', response(''), 'CALENDAR_EMPTY_RESPONSE'],
];
const results = [];
for (const [name, fetchImplementation, code, env] of cases) {
  const result = await load(fetchImplementation, env).invoke();
  assert.equal(Boolean(result.isError), Boolean(code), name);
  if (code) assert.ok(result.content[0].text.startsWith(`[${code}]`), name);
  else assert.equal(result.content[0].text, '{\n  "events": []\n}');
  assert.ok(!JSON.stringify(result).includes(marker), `${name}: no secret leakage`);
  results.push({case:name,passed:true,code});
}

for (const [name, auth, env, status] of [
  ['No MCP token rejected', undefined, fixtureEnv, 401],
  ['Wrong MCP token rejected', 'Bearer wrong', fixtureEnv, 401],
  ['Missing configured token rejected', 'Bearer undefined', {...fixtureEnv, MCP_TOKEN:undefined}, 401],
  ['Correct MCP token reaches transport', 'Bearer test-mcp-token', fixtureEnv, 200],
]) {
  const server = load(response('{}'), env);
  const request = new Request('https://worker.example.test/mcp', {headers: auth ? {Authorization:auth} : {}});
  const result = await server.worker.fetch(request, env, {});
  assert.equal(result.status, status);
  assert.equal(server.transportCalls(), status === 200 ? 1 : 0);
  results.push({case:name,passed:true});
}
console.log(`${results.length} checks passed; original JSON behavior and access gate preserved.`);
console.log('Scope: real callback and access gate, mocked MCP transport, synthetic upstream data. No live secrets used.');

