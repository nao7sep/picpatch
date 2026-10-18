import { PicPatchSdkError } from '../../errors.ts';

type Shapes = Record<string, { shape?: number[] }>;
/** Aliases for the conventional SD UNet layout, not a general tensor converter. */
function diffusersName(name: string): string | undefined {
  const resnet = (tail: string) => tail.replace(/^in_layers\.0(?=\.|$)/, 'norm1').replace(/^in_layers\.2(?=\.|$)/, 'conv1')
    .replace(/^emb_layers\.1(?=\.|$)/, 'time_emb_proj').replace(/^out_layers\.0(?=\.|$)/, 'norm2')
    .replace(/^out_layers\.3(?=\.|$)/, 'conv2').replace(/^skip_connection(?=\.|$)/, 'conv_shortcut');
  // The pinned converter does not rewrite direct Diffusers conv/time-embedding
  // names with a LoRA suffix. Original-layout names remain supported below.
  let match = /^input_blocks\.(\d+)\.(\d+)\.(.+)$/.exec(name);
  if (match) {
    const index = Number(match[1]); const block = Math.floor((index - 1) / 3); const layer = (index - 1) % 3;
    if (layer === 2 && match[3] === 'op') return `down_blocks.${block}.downsamplers.0.conv`;
    return `down_blocks.${block}.${match[2] === '0' ? 'resnets' : 'attentions'}.${layer}.${match[2] === '0' ? resnet(match[3]!) : match[3]}`;
  }
  match = /^output_blocks\.(\d+)\.(\d+)\.(.+)$/.exec(name);
  if (match) {
    const block = Math.floor(Number(match[1]) / 3); const layer = Number(match[1]) % 3;
    if (match[3] === 'conv') return `up_blocks.${block}.upsamplers.0.conv`;
    return `up_blocks.${block}.${match[2] === '0' ? 'resnets' : 'attentions'}.${layer}.${match[2] === '0' ? resnet(match[3]!) : match[3]}`;
  }
  match = /^middle_block\.(\d+)\.(.+)$/.exec(name);
  if (match) return match[1] === '1' ? `mid_block.attentions.0.${match[2]}` : `mid_block.resnets.${Number(match[1]) / 2}.${resnet(match[2]!)}`;
  return undefined;
}

/** Every low-rank target must exist in the selected checkpoint with matching dimensions. */
export function validateLoraTensors(checkpoint: Shapes, lora: Shapes): void {
  const reject = (): never => { throw new PicPatchSdkError('INVALID_REQUEST', 'LoRA tensors must be compatible SD UNet up/down pairs. Text-encoder, DoRA, LyCORIS and unknown target formats are unsupported.'); };
  const targets = new Map<string, { shape: number[]; key: string }>();
  for (const [key, value] of Object.entries(checkpoint)) {
    if (!key.startsWith('model.diffusion_model.') || !key.endsWith('.weight') || !value?.shape) continue;
    const name = key.slice('model.diffusion_model.'.length, -'.weight'.length);
    for (const alias of [name, diffusersName(name)]) if (alias) targets.set(`lora_unet_${alias.replaceAll('.', '_')}`, { shape: value.shape, key });
  }
  const bases = new Set<string>();
  for (const key of Object.keys(lora)) {
    if (key === '__metadata__') continue;
    const match = /^(lora_unet_.+)\.(?:lora_(?:up|down)\.weight|alpha)$/.exec(key);
    if (!match) reject();
    bases.add(match![1]!);
  }
  if (bases.size === 0) reject();
  const applied = new Set<string>();
  for (const base of bases) {
    const selected = targets.get(base);
    if (selected && applied.has(selected.key)) reject();
    if (selected) applied.add(selected.key);
    const target = selected?.shape; const down = lora[`${base}.lora_down.weight`]?.shape; const up = lora[`${base}.lora_up.weight`]?.shape;
    const alpha = lora[`${base}.alpha`];
    if (!target || !down || !up || ![2, 4].includes(target.length) || down.length !== target.length || up.length !== target.length ||
      [...target, ...down, ...up].some(value => !Number.isSafeInteger(value) || value <= 0) ||
      down[0] !== up[1] || down[1] !== target[1] || up[0] !== target[0] ||
      (target.length === 4 && (down[2] !== target[2] || down[3] !== target[3] || up[2] !== 1 || up[3] !== 1)) ||
      (alpha && (!Array.isArray(alpha.shape) || alpha.shape.reduce((product, n) => product * n, 1) !== 1))) reject();
  }
}
