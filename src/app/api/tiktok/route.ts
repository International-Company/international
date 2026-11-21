import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { list, MAX_NAME, record } from '@/modules/tiktok/tiktok.service';

export const GET = route({
  permissions: ['exchange.remittance.use'],
  handler: async ({ actor }) => list(actor),
});

const bodySchema = z.object({
  amount: z.string(),
  rate: z.string(),
  account: z.string().max(60),
  beneficiaryName: z.string().max(MAX_NAME),
  channel: z.string().max(80),
  /** The pounds the photo shows; optional. */
  egpAmount: z.string().max(30).nullish(),
  /** How it is handed over, and split, the part sent by transfer. */
  payVia: z.enum(['TRANSFER', 'CASH', 'SPLIT']).optional(),
  /** Further photos — the transfer's receipt, say — shrunk by the screen. */
  extraPhotos: z.array(z.string().min(1).max(6_000_000)).max(4).optional(),
  transferPart: z.string().max(30).nullish(),
  /** Whom it is sent to, by the name set on the WhatsApp panel. */
  recipient: z.string().max(60).nullish(),
  /** The photo, shrunk by the screen, as base64. The service checks what it is. */
  photo: z.string().min(1).max(6_000_000),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.remittance.use'],
  bodySchema,
  handler: async ({ body, actor }) =>
    record(
      {
        amount: parseMoney(body.amount),
        rate: parseMoney(body.rate),
        account: body.account,
        beneficiaryName: body.beneficiaryName,
        channel: body.channel,
        photo: body.photo,
        egpAmount: body.egpAmount?.trim() ? parseMoney(body.egpAmount) : null,
        payVia: body.payVia ?? 'TRANSFER',
        extraPhotos: body.extraPhotos ?? [],
        transferPart: body.transferPart?.trim() ? parseMoney(body.transferPart) : null,
        recipient: body.recipient ?? null,
      },
      actor,
    ),
});
