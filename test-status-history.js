'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let backendStatus = 200;
let backendResponse = null;
let backendRequest = null;
const redirects = [];
const context = {
  window: {},
  document: { querySelector: () => null, addEventListener() {} },
  location: {
    origin: 'https://example.test',
    href: 'https://example.test/',
    replace: (url) => redirects.push(url)
  },
  localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
  fetch: async (input, init) => {
    backendRequest = { input: String(input), init };
    return new Response(JSON.stringify(backendResponse), { status: backendStatus });
  },
  Headers, Response, URL, WebSocket: undefined, setTimeout, clearTimeout, console
};
context.window = context;
context.addEventListener = () => {};
context.removeEventListener = () => {};
const index = fs.readFileSync('index.html', 'utf8');
assert.match(index, /src="\/assets\/cfsm-adapter-v1\.0\.8\.js"/);
const adapter = fs.readFileSync('assets/cfsm-adapter-v1.0.8.js', 'utf8');
assert.doesNotMatch(adapter, /Map markers show Cloudflare/);
vm.runInNewContext(adapter, context);
const { calculateAvailability, buildStatusHistory } = context.CFSMStatusHistory;
const end = 1_700_000_000;
const start = end - 7 * 86400;
const rows = [{ server_id: 's1', t: start, is_online: 1, event_type: 'baseline' }, { server_id: 's1', t: end - 3600, is_online: 0, event_type: 'transition' }];
const result = calculateAvailability(rows, end, start);
assert.equal(result.d30, (6 * 86400 + 23 * 3600) / (7 * 86400) * 100);
assert.equal(result.h24, (23 * 3600) / 86400 * 100);
assert.equal(result.down.at(-1), 60);
const direct = buildStatusHistory(rows, end, start, 's1', 42);
assert.equal(direct.events[0].kind, 'offline');
assert.equal(direct.events[0].server_id, 42);
const anchorRows = [{ server_id: 's1', t: start - 60, is_online: 1, event_type: 'transition' }, rows[1]];
const anchored = buildStatusHistory(anchorRows, end, start, 's1');
assert.equal(anchored.availability.d30, result.d30);
assert.equal(anchored.events.length, 1);
assert.equal(anchored.events[0].t, end - 3600);
assert.equal(calculateAvailability([], end, start).d30, null);

async function testLoginResponse() {
  backendStatus = 200;
  backendResponse = { success: true, token: 'test-jwt', message: 'loginSuccessful' };
  const success = await context.fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { kind: 'admin' });
  assert.equal(backendRequest.input, 'https://example.test/admin/api');
  assert.equal(backendRequest.init.method, 'POST');
  assert.equal(backendRequest.init.credentials, 'include');
  assert.deepEqual(JSON.parse(backendRequest.init.body), {
    action: 'login', username: 'admin', password: 'test-password'
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(redirects, ['https://example.test/admin#/admin']);

  backendStatus = 401;
  backendResponse = { success: false, message: 'invalidCredentials' };
  const rejected = await context.fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
  });
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { error: 'invalidCredentials' });
  assert.deepEqual(redirects, ['https://example.test/admin#/admin']);
}

testLoginResponse().then(() => {
  console.log('status history and v1.0.8 login redirect tests: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
