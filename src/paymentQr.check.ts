/**
 * `npm run check` - asserts the payment QR payload.
 *
 * The slot rules (captain / player / substitute limits) live in the database
 * function register_player(), and are checked from the website repo with
 * `bun run db:check-register`.
 */

import assert from 'node:assert/strict';
import { spayd, paymentQrPng, qrMessage } from './paymentQr.ts';

assert.equal(qrMessage('Zephyr', 'Master'), 'Zephyr Master');

assert.equal(
  spayd({ iban: 'CZ65 0800 0000 1920 0014 5399', amountCzk: 250, variableSymbol: 100001, message: 'nick*name Master' }),
  'SPD*1.0*ACC:CZ6508000000192000145399*AM:250.00*CC:CZK*X-VS:100001*MSG:nickname Master',
);

// A 60-character cap on the message, and no field separator can leak into it.
const long = spayd({ iban: 'CZ65', amountCzk: 1, variableSymbol: 1, message: 'x'.repeat(80) });
// SPD, 1.0, ACC, AM, CC, X-VS, MSG - a `*` inside the message would add one.
assert.equal(long.split('*').length, 7);
assert.equal(long.split('MSG:')[1]!.length, 60);

const png = await paymentQrPng({ iban: 'CZ6508000000192000145399', amountCzk: 1, variableSymbol: 1, message: 'x' });
assert.equal(png.subarray(1, 4).toString(), 'PNG');

console.log('payment QR checks passed');
