/**
 * Czech bank payment QR ("QR Platba", SPAYD format). Every Czech banking app
 * reads it and pre-fills account, amount, variable symbol and message.
 */

import QRCode from 'qrcode';

export type Payment = {
  iban: string;
  amountCzk: number;
  /** Numeric, up to 10 digits - how the organizer matches the payment. */
  variableSymbol: number;
  message: string;
};

/** SPAYD's cap on the message for the recipient. */
const MAX_MESSAGE = 60;

/** Czech banks often mangle accents in QR payments, and "*" separates SPAYD fields. */
const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What the organizer reads in their statement: "Ghost | Podzimni Liga #7 | Tournevo".
 * Same rules as the website's (packages/api/src/payment-message.ts) - keep them in step.
 */
export function qrMessage(nickname: string, tournament: string): string {
  const nick = plain(nickname).slice(0, 32);
  const name = plain(tournament);
  const full = `${nick} | ${name} | Tournevo`;
  if (full.length <= MAX_MESSAGE) return full;
  return `${nick} | ${name}`.slice(0, MAX_MESSAGE).trimEnd();
}

export function spayd({ iban, amountCzk, variableSymbol, message }: Payment): string {
  // `*` separates fields in SPAYD; the spec caps MSG at 60 characters.
  const msg = message.replaceAll('*', '').slice(0, 60);
  return [
    'SPD*1.0',
    `ACC:${iban.replaceAll(' ', '')}`,
    `AM:${amountCzk.toFixed(2)}`,
    'CC:CZK',
    `X-VS:${variableSymbol}`,
    `MSG:${msg}`,
  ].join('*');
}

export function paymentQrPng(payment: Payment): Promise<Buffer> {
  return QRCode.toBuffer(spayd(payment), { width: 400, margin: 2 });
}
