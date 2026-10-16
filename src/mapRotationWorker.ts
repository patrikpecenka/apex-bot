import { buildMapRotationMessageUnsafe, type MapRotationData } from './mapRotation.ts';

process.once('message', async ({ data, nowMs }: { data: MapRotationData; nowMs: number }) => {
  try {
    const rendered = await buildMapRotationMessageUnsafe(data, nowMs);
    const files = rendered.files.map((file) => {
      if (!Buffer.isBuffer(file.attachment)) throw new Error('Map renderer did not return a buffer');
      return { name: file.name, image: file.attachment.toString('base64') };
    });
    process.send?.({ embeds: rendered.embeds.map((embed) => embed.toJSON()), files }, () => process.exit(0));
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.exit(0));
  }
});
