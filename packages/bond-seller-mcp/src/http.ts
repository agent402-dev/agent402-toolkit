// Serves the Bond Job Protocol over HTTP with node:http (GET /quote, POST /open, POST /deliver).
import { createServer, type IncomingMessage, type Server } from 'node:http';

const MAX_BODY = 80_000;

async function readBody(req: IncomingMessage): Promise<string | null> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function serveHttp(handle: (r: Request) => Promise<Response | null>, port: number, host: string): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      if (body === null) { res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"body too large"}'); return; }
      const url = `http://${req.headers.host ?? `${host}:${port}`}${req.url ?? '/'}`;
      const r = await handle(new Request(url, { method: req.method, headers: { 'content-type': 'application/json' }, body }));
      if (!r) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); return; }
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal error"}');
    }
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server)); });
}
