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

/** What the payer's bank statement shows next to the payment. */
export function qrMessage(nickname: string, rank: string): string {
  return `${nickname} ${rank}`;
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
