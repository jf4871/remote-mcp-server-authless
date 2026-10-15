// Local-only browser fixture. Start the synthetic Worker first.
// Open http://127.0.0.1:8878/start and submit the consent form with an EMPTY key.
// Expected: key rejected (401), never Invalid form origin (403).
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
const base = 'http://127.0.0.1:8789';
http.createServer(async (req, res) => {
  if (req.url !== '/start') { res.writeHead(404); res.end(); return; }
  try {
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const response = await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Local browser regression test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
    if (response.status !== 201) throw new Error('Local registration failed');
    const client = await response.json();
    const verifier = randomBytes(48).toString('base64url');
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope: 'calendar:read offline_access', state: 'local-browser-test', resource: base + '/mcp', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    res.writeHead(302, { Location: base + '/authorize?' + params, 'Cache-Control': 'no-store' });
    res.end();
  } catch { res.writeHead(503); res.end('Start the synthetic local Worker first.'); }
}).listen(8878, '127.0.0.1', () => console.log('Local browser fixture ready at http://127.0.0.1:8878/start; use an EMPTY key.'));
