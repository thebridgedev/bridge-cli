/**
 * No redirect is ever followed, against Node's real fetch and real servers:
 * a 302 from discovery or from an API route is an error, the address in
 * `Location` gets no request, and no token goes anywhere but where it was sent.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { discover } from '../core/discovery';
import { call, type Fetch } from '../core/http';

interface Server {
  url: string;
  hits: { path: string; authorization?: string }[];
  close: () => Promise<void>;
}

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Server> {
  const hits: Server['hits'] = [];
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url ?? '', ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }) });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

let elsewhere: Server;
let bridge: Server;

beforeEach(async () => {
  elsewhere = await serve((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ issuer: 'anything' }));
  });
  bridge = await serve((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `${elsewhere.url}/stolen`);
    res.end();
  });
});
afterEach(async () => {
  await elsewhere.close();
  await bridge.close();
});

const realFetch: Fetch = (input, init) => fetch(input, init);

it('a 302 from discovery is refused, and the Location gets no request', async () => {
  await expect(discover(realFetch, `${bridge.url}/identity-access/apps/a`)).rejects.toMatchObject({ kind: 'misconfigured', status: 302 });
  expect(bridge.hits).toHaveLength(1);
  expect(elsewhere.hits).toEqual([]);
});

it('a 302 from an API route is refused, and the token goes nowhere else', async () => {
  await expect(call(realFetch, { method: 'GET', url: `${bridge.url}/v2/app-registry/apps`, headers: { authorization: 'Bearer at-secret' } })).rejects.toMatchObject({
    kind: 'misconfigured',
    message: expect.stringContaining('redirect, which the CLI never follows'),
  });
  expect(bridge.hits).toEqual([{ path: '/v2/app-registry/apps', authorization: 'Bearer at-secret' }]);
  expect(elsewhere.hits).toEqual([]);
});

it('a 307 on a write is refused too, with the body sent nowhere else', async () => {
  const temporary = await serve((_req, res) => {
    res.statusCode = 307;
    res.setHeader('location', `${elsewhere.url}/stolen`);
    res.end();
  });
  try {
    await expect(call(realFetch, { method: 'POST', url: `${temporary.url}/v2/billing/connection`, headers: { 'x-api-key': 'bk.a.k.secret' }, body: { secretKey: 'sk_test_x' } })).rejects.toMatchObject({ kind: 'misconfigured' });
    expect(elsewhere.hits).toEqual([]);
  } finally {
    await temporary.close();
  }
});
