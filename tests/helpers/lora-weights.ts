import { writeFile } from 'node:fs/promises';
/** Small deterministic, untrained LoRA: tests application and scale, never style quality. */
export async function loraWeights(path: string, xl = false): Promise<void> {
  const tensors: Record<string, { dtype: string; shape: number[]; data_offsets: number[] }> = {};
  const buffers: Buffer[] = []; let offset = 0;
  for (const projection of ['to_k', 'to_v']) {
    const target = `lora_unet_down_blocks_${xl ? 1 : 0}_attentions_0_transformer_blocks_0_attn2_${projection}`;
    for (const [suffix, shape] of [['lora_down.weight', [1, xl ? 2048 : 768]], ['lora_up.weight', [xl ? 640 : 320, 1]]] as const) {
      const data = Buffer.alloc(shape[0] * shape[1] * 4);
      for (let i = 0; i < data.length / 4; i++) data.writeFloatLE(Math.sin(i + 1) * 0.1, i * 4);
      tensors[`${target}.${suffix}`] = { dtype: 'F32', shape: [...shape], data_offsets: [offset, offset + data.length] };
      buffers.push(data); offset += data.length;
    }
  }
  const json = JSON.stringify(tensors); const header = Buffer.from(json.padEnd(Math.ceil(Buffer.byteLength(json) / 8) * 8));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  await writeFile(path, Buffer.concat([length, header, ...buffers]));
}

export async function kleinLoraWeights(path: string): Promise<void> {
  const tensors: Record<string, { dtype: string; shape: number[]; data_offsets: number[] }> = {};
  const buffers: Buffer[] = []; let offset = 0;
  for (const [suffix, shape] of [['lora_A.weight', [1, 128]], ['lora_B.weight', [3072, 1]]] as const) {
    const data = Buffer.alloc(shape[0] * shape[1] * 4);
    for (let i = 0; i < data.length / 4; i++) data.writeFloatLE(Math.sin(i + 1) * 0.1, i * 4);
    tensors[`transformer.x_embedder.${suffix}`] = { dtype: 'F32', shape: [...shape], data_offsets: [offset, offset + data.length] };
    buffers.push(data); offset += data.length;
  }
  const json = JSON.stringify(tensors); const header = Buffer.from(json.padEnd(Math.ceil(Buffer.byteLength(json) / 8) * 8));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  await writeFile(path, Buffer.concat([length, header, ...buffers]));
}
