#!/usr/bin/env node
// @agent402-dev/pay-server command line: register (signed seller registration), check (read your 402 like a buyer, no wallet). The library itself is used from code (createPaymentGate).
import { writeFileSync } from 'node:fs';
import { buildRegistration, REGISTER_HELP } from './register.js';
import { CHECK_HELP, check402Url, errorJson, findingsJson, formatFindings, parseCheckArgs } from './check402.js';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'register') {
  try {
    const doc = await buildRegistration(args);
    const json = JSON.stringify(doc, null, 2) + '\n';
    const i = args.indexOf('--out');
    if (i >= 0 && args[i + 1]) {
      writeFileSync(args[i + 1], json, { flag: 'wx' });
      console.error(`Wrote ${args[i + 1]}. Serve it at /.well-known/agent402.json`);
    } else process.stdout.write(json);
  } catch (e) {
    console.error((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'The --out file already exists. It was not changed.' : (e as Error).message);
    process.exitCode = 1;
  }
} else if (cmd === 'check') {
  const a = parseCheckArgs(args);
  if ('error' in a) { console.error(a.error); console.log(CHECK_HELP); process.exitCode = 2; }
  else {
    try {
      const list = await check402Url(a.url, a.method === 'POST' ? { method: 'POST', body: a.body } : {});
      console.log(a.json ? findingsJson(a.url, list) : formatFindings(list, { method: a.method, url: a.url }));
      process.exitCode = list.some((x) => x.level === 'fix') ? 1 : 0;
    } catch (e) {
      const m = `Request failed: ${(e as Error).message}`;
      if (a.json) console.log(errorJson(a.url, m)); else console.error(m);
      process.exitCode = 1;
    }
  }
} else {
  console.log(REGISTER_HELP);
  console.log('');
  console.log(CHECK_HELP);
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2;
}
