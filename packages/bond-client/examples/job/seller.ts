// Seller side: an HTTP service that takes a job, locks a performance bond with the buyer, does the work,
// marks delivery on-chain and hands over the result. All of it is the Agent402 Bond Job Protocol v1 handler from
// @agent402-dev/pay-server/bond; this file only plugs it into node:http.
//
//   GET  /quote    terms the seller offers
//   POST /open     { buyer, input }        -> open transaction signed by the seller
//   POST /deliver  { deal, expires, signature } -> runs the job, marks delivery, returns the result
//
// The seller never holds the buyer's money: the deposit sits in the deal vault and the balance goes straight
// from buyer to seller when the buyer confirms. The SDK takes a signer, never a private key.
import { createServer, type Server } from 'node:http';
import { type BondJobStore, type BondSigner, type BondTermsConfig, bondJobService, createBondSeller } from '@agent402-dev/pay-server/bond';

export interface SellerOptions {
  rpcUrl: string;
  signer: BondSigner;
  terms: BondTermsConfig;
  /** Persist jobs in production so you can still mark delivery after a restart. Default: in memory */
  store?: BondJobStore;
  description?: string;
  /** The actual work. Keep it shorter than terms.deliverSeconds. */
  doJob: (input: string) => Promise<unknown>;
}

export function startSeller(o: SellerOptions, port: number): Promise<Server> {
  const seller = createBondSeller({ rpcUrl: o.rpcUrl, signer: o.signer, terms: o.terms, store: o.store });
  const service = bondJobService({ seller, description: o.description, doJob: (input) => o.doJob(input) });
  const handle = service.handle;
  // Do the work and mark delivery as soon as a buyer's open lands, without waiting for the buyer to ask.
  // (Otherwise a buyer could open, never fetch the result, and take the bond at the deadline.)
  const timer = setInterval(() => { service.processOpenJobs().catch((e) => console.warn('processOpenJobs:', (e as Error).message)); }, 5_000);

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 100_000) { res.writeHead(413).end(); return; } }
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method === 'POST' ? { body } : {}) });
    const r = (await handle(request)) ?? Response.json({ error: 'not found' }, { status: 404 });
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
  });
  server.on('close', () => clearInterval(timer));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
