#!/usr/bin/env node
// @agent402-dev/pay-server command line: register (signed seller registration). The library itself is used from code (createPaymentGate).
import { writeFileSync } from 'node:fs';
import { buildRegistration, REGISTER_HELP } from './register.js';

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
} else {
  console.log(REGISTER_HELP);
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2;
}
