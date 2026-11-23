// Test helper: a fake Solana RPC + chain that applies Agent402 Bond open, mark, confirm, pay, settle and claims
// the way the program records them (deal account layout only; no token balances).
import { PublicKey } from '@solana/web3.js';
import { BOND_PROGRAM, DEAL_DISCRIMINATOR } from '@agent402-dev/pay-mcp/bond';
import { BOND_DISC, decodeOpenData, parseTx } from '@agent402-dev/pay-mcp/bond-tx';

export const NOW = 1_800_000_000n;
export const BH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

/** A fake chain: applies `open` and `mark_delivered` the way the program records them. */
export function chain() {
  const accounts = new Map<string, Uint8Array>();
  const sent: { by: string; kind: string }[] = [];
  const opts = { failNextMark: false, failClaimBuyer: false, now: NOW };
  const same = (d: Uint8Array, disc: readonly number[]) => Array.from(d.subarray(0, 8)).join() === disc.join();
  function apply(tx: Uint8Array) {
    const p = parseTx(tx);
    for (const ix of p.instructions) {
      if (ix.programId !== BOND_PROGRAM) continue;
      const disc = Array.from(ix.data.subarray(0, 8)).join();
      if (disc === BOND_DISC.open.join()) {
        const { nonce, terms: t } = decodeOpenData(ix.data)!;
        const b = new Uint8Array(196); const v = new DataView(b.buffer);
        b.set(DEAL_DISCRIMINATOR, 0);
        let o = 8;
        for (const k of [ix.keys[0].pubkey, ix.keys[1].pubkey, ix.keys[2].pubkey]) { b.set(new PublicKey(k).toBytes(), o); o += 32; }
        for (const x of [nonce, t.price, t.sellerBond, t.buyerDeposit]) { v.setBigUint64(o, x, true); o += 8; }
        for (const x of [t.deliverBy, t.lateWindow, t.payWindow, NOW, 0n, 0n]) { v.setBigInt64(o, x, true); o += 8; }
        accounts.set(ix.keys[5].pubkey, b);
        sent.push({ by: p.keys[0], kind: 'open' });
      } else if (disc === Array.from(Buffer.from([240, 118, 188, 142, 64, 85, 107, 18])).join()) {
        const b = accounts.get(ix.keys[1].pubkey)!;
        new DataView(b.buffer).setBigInt64(8 + 96 + 32 + 32, NOW + 5n, true); // seller_mark
        sent.push({ by: p.keys[0], kind: 'mark' });
      } else if (same(ix.data, BOND_DISC.confirm_receipt)) {
        new DataView(accounts.get(ix.keys[1].pubkey)!.buffer).setBigInt64(176, NOW + 6n, true); // buyer_confirm
        sent.push({ by: p.keys[0], kind: 'confirm' });
      } else if (same(ix.data, BOND_DISC.pay_balance)) {
        accounts.get(ix.keys[1].pubkey)![184] = 1; // balance_paid
        sent.push({ by: p.keys[0], kind: 'pay' });
      } else if (same(ix.data, BOND_DISC.settle)) {
        const b = accounts.get(ix.keys[0].pubkey)!;
        b[187] = b[184] === 1 ? 1 : 3; // outcome + 1: delivered / disputed
        sent.push({ by: p.keys[0], kind: 'settle' });
      } else if (same(ix.data, BOND_DISC.claim_seller)) {
        if (!opts.failClaimBuyer) accounts.delete(ix.keys[1].pubkey); // claim_seller closes the deal once the vault is empty
        sent.push({ by: p.keys[0], kind: 'claim' });
      } else if (same(ix.data, BOND_DISC.claim_buyer)) {
        sent.push({ by: p.keys[0], kind: 'claim_buyer' });
      }
    }
  }
  const rpcFetch = (async (_u: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    const ok = (result: unknown) => new Response(JSON.stringify({ result }));
    if (method === 'getSlot') return ok(1);
    if (method === 'getBlockTime') return ok(Number(opts.now));
    if (method === 'getLatestBlockhash') return ok({ value: { blockhash: BH } });
    if (method === 'getMultipleAccounts') return ok({ value: (params[0] as string[]).map((k) => { const a = accounts.get(k); return a ? { owner: BOND_PROGRAM, data: [Buffer.from(a).toString('base64'), 'base64'] } : null; }) });
    if (method === 'getAccountInfo') { const a = accounts.get(params[0] as string); return ok({ value: a ? { owner: BOND_PROGRAM, data: [Buffer.from(a).toString('base64'), 'base64'] } : null }); }
    if (method === 'sendTransaction') {
      const bytes = Uint8Array.from(Buffer.from(params[0] as string, 'base64'));
      const isMark = parseTx(bytes).instructions.some((i) => Array.from(i.data.subarray(0, 8)).join() === '240,118,188,142,64,85,107,18');
      if (isMark && opts.failNextMark) { opts.failNextMark = false; return new Response(JSON.stringify({ error: { message: 'blockhash not found' } })); }
      // A frozen or closed buyer token account: any transaction with claim_buyer fails in preflight
      const hasClaimBuyer = parseTx(bytes).instructions.some((i) => same(i.data, BOND_DISC.claim_buyer));
      if (hasClaimBuyer && opts.failClaimBuyer) return new Response(JSON.stringify({ error: { message: 'Transaction simulation failed: account frozen' } }));
      apply(bytes);
      return ok('SIG');
    }
    if (method === 'getSignatureStatuses') return ok({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
    return new Response(JSON.stringify({ error: { message: method } }));
  }) as unknown as typeof fetch;
  return { accounts, sent, apply, rpcFetch, opts };
}

