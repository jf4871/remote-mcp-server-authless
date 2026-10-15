// Run against the LOCAL Worker from oauth-test.wrangler.jsonc, never production.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
const base = 'http://127.0.0.1:8789';
const key = 'SYNTHETIC_OWNER_KEY_FOR_LOCAL_TEST_ONLY_12345';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
let count = 0;
const pass = name => { count++; console.log(`PASS: ${name}`); };
const feed = http.createServer((req,res) => { res.writeHead(200,{'Content-Type':'text/calendar'}); res.end('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic\r\nDTSTART:20261015T090000Z\r\nSUMMARY:Synthetic OAuth appointment\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'); });
await new Promise(resolve => feed.listen(8879,'127.0.0.1',resolve));
const jsonPost = (url, body, headers={}) => fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),redirect:'manual'});
const formPost = (url, body, headers={}) => fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(body),redirect:'manual'});
try {
  const unauthorized = await fetch(base+'/mcp');
  assert.equal(unauthorized.status,401);
  assert.match(unauthorized.headers.get('www-authenticate'),/resource_metadata/);
  pass('Unauthenticated MCP remains protected and advertises OAuth discovery');
  const metadata = await (await fetch(base+'/.well-known/oauth-authorization-server')).json();
  assert.ok(metadata.registration_endpoint && metadata.token_endpoint && metadata.authorization_endpoint);
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  pass('Authorization metadata exposes registration, token endpoint and PKCE');
  const protectedResource = await (await fetch(base+'/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(protectedResource.resource,base+'/mcp');
  assert.ok(protectedResource.scopes_supported.includes('calendar:read'));
  pass('Resource discovery identifies the calendar read scope');
  const rejectedRegistration = await jsonPost(metadata.registration_endpoint,{redirect_uris:['https://attacker.example/callback'],token_endpoint_auth_method:'none'});
  assert.equal(rejectedRegistration.status,400);
  pass('Registration rejects unrelated redirect destinations');
  for (const rejectedUri of ['https://chatgpt.com/connector_platform_oauth_redirect/extra', 'https://chatgpt.com.attacker.example/connector_platform_oauth_redirect']) {
    const rejected = await jsonPost(metadata.registration_endpoint,{redirect_uris:[rejectedUri],token_endpoint_auth_method:'none'});
    assert.equal(rejected.status,400);
  }
  pass('ChatGPT shared callback remains restricted to its exact host and path');
  const registration = await jsonPost(metadata.registration_endpoint,{client_name:'<script>untrusted-client</script>',redirect_uris:[redirectUri],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  assert.equal(registration.status,201);
  const client = await registration.json();
  pass('ChatGPT callback client can register');
  async function begin() {
    const verifier = randomBytes(48).toString('base64url');
    const params = new URLSearchParams({client_id:client.client_id,redirect_uri:redirectUri,response_type:'code',scope:'calendar:read offline_access',state:'test-state',resource:base+'/mcp',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    const result = await fetch(metadata.authorization_endpoint+'?'+params,{redirect:'manual'});
    const html = await result.text();
    assert.equal(result.status,200,html);
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = result.headers.get('set-cookie').split(';')[0];
    return {verifier,handle,cookie,html,result};
  }
  const first = await begin();
  assert.ok(!first.html.includes('<script>untrusted-client</script>'));
  assert.match(first.html,/&#60;script&#62;/);
  assert.ok(!first.html.includes(key));
  assert.match(first.result.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  pass('Consent escapes untrusted client names and hides the owner key');
  assert.equal(first.result.headers.get('referrer-policy'),'same-origin');
  pass('Consent policy preserves Origin for same-origin browser form submissions');
  const badKey = await formPost(base+'/authorize',{handle:first.handle,decision:'approve',owner_key:'incorrect'},{Origin:base,Cookie:first.cookie});
  assert.equal(badKey.status,401);
  pass('Wrong owner key cannot approve a calendar grant');
  const badOrigin = await formPost(base+'/authorize',{handle:first.handle,decision:'approve',owner_key:key},{Origin:'https://attacker.example',Cookie:first.cookie});
  assert.equal(badOrigin.status,403);
  pass('Cross-origin approval is refused');
  for (const headers of [{Cookie:first.cookie},{Origin:'null',Cookie:first.cookie}]) {
    const response = await formPost(base+'/authorize',{handle:first.handle,decision:'approve',owner_key:key},headers);
    assert.equal(response.status,403);
  }
  pass('Missing and null origins remain rejected');
  const missingCookie = await formPost(base+'/authorize',{handle:first.handle,decision:'approve',owner_key:key},{Origin:base});
  assert.equal(missingCookie.status,400);
  pass('Approval requires the browser-bound consent cookie');
  const denied = await begin();
  const denyResponse = await formPost(base+'/authorize',{handle:denied.handle,decision:'deny'},{Origin:base,Cookie:denied.cookie});
  assert.equal(denyResponse.status,302);
  assert.equal(new URL(denyResponse.headers.get('location')).searchParams.get('error'),'access_denied');
  pass('Deny returns no calendar grant');
  async function approve() {
    const flow = await begin();
    const result = await formPost(base+'/authorize',{handle:flow.handle,decision:'approve',owner_key:key},{Origin:base,Cookie:flow.cookie});
    assert.equal(result.status,302,await result.clone().text());
    const dest = new URL(result.headers.get('location'));
    assert.equal(dest.origin+dest.pathname,redirectUri);
    assert.equal(dest.searchParams.get('state'),'test-state');
    return {...flow,code:dest.searchParams.get('code')};
  }
  const wrongPkce = await approve();
  const badExchange = await formPost(metadata.token_endpoint,{grant_type:'authorization_code',client_id:client.client_id,code:wrongPkce.code,redirect_uri:redirectUri,resource:base+'/mcp',code_verifier:'incorrect-verifier'});
  assert.equal(badExchange.status,400);
  pass('Wrong PKCE verifier cannot obtain tokens');
  const approved = await approve();
  const exchangeBody={grant_type:'authorization_code',client_id:client.client_id,code:approved.code,redirect_uri:redirectUri,resource:base+'/mcp',code_verifier:approved.verifier};
  const exchanged = await formPost(metadata.token_endpoint,exchangeBody);
  assert.equal(exchanged.status,200,await exchanged.clone().text());
  const tokens = await exchanged.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  pass('Owner approval and PKCE produce access and refresh tokens');
  async function rpc(token,method,params={},id=1) {
    const response = await jsonPost(base+'/mcp',{jsonrpc:'2.0',id,method,params},{Authorization:'Bearer '+token,Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'});
    const body = await response.text();
    const data = body.startsWith('event:') || body.startsWith('data:') ? body.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)))[0] : JSON.parse(body);
    return {status:response.status,data};
  }
  const initialized = await rpc(tokens.access_token,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Synthetic acceptance test',version:'1'}});
  assert.equal(initialized.status,200);
  assert.ok(initialized.data.result.serverInfo);
  pass('OAuth token completes the real MCP initialization');
  const listed = await rpc(tokens.access_token,'tools/list');
  assert.equal(listed.data.result.tools[0].name,'get_calendar_events');
  assert.equal(listed.data.result.tools[0].annotations.readOnlyHint,true);
  pass('Calendar tool is discoverable and marked read-only');
  const called = await rpc(tokens.access_token,'tools/call',{name:'get_calendar_events',arguments:{}});
  assert.equal(called.data.result.isError,undefined);
  assert.equal(JSON.parse(called.data.result.content[0].text).events[0].title,'Synthetic OAuth appointment');
  pass('OAuth client reads a synthetic calendar through the real MCP tool');
  const legacy = await rpc(key,'tools/list');
  assert.equal(legacy.data.result.tools[0].name,'get_calendar_events');
  pass('Existing Codex bearer-key connection still works');
  const refreshed = await formPost(metadata.token_endpoint,{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:base+'/mcp'});
  assert.equal(refreshed.status,200,await refreshed.clone().text());
  const newTokens=await refreshed.json();
  assert.ok(newTokens.access_token);
  pass('Refresh token maintains the authorized connection');
  const replay = await formPost(metadata.token_endpoint,exchangeBody);
  assert.equal(replay.status,400);
  pass('Authorization code cannot be reused');
  const invalidToken = await fetch(base+'/mcp',{headers:{Authorization:'Bearer invalid'}});
  assert.equal(invalidToken.status,401);
  pass('Invalid bearer tokens remain rejected');
  console.log(`${count} OAuth integration checks passed. Only synthetic local data was used.`);
} finally { await new Promise(resolve=>feed.close(resolve)); }
