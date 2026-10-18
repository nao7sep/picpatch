import { inspectNativeAssets } from './assets.ts';
import { randomInt } from 'node:crypto';
import { writeFile, mkdir, copyFile, symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { EditBackend } from '../../execution/backend.ts';
import type { LocalEditingModel, ModelCapabilities } from '../../contracts.generated.ts';
import type { ImageRequest, EditRequest, GenerateRequest, EditResult, OperationOptions } from '../../types.ts';
import { validateEditRequest, validateGenerateRequest } from '../../validation.ts';
import { resolveParameters } from '../../parameters.ts';
import { checkSignal, emitProgress } from '../../operations.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { nativeCapabilities, nativeRevision } from './models.ts';
import { NativeProcess } from './process.ts';
import type { WorkerTimeouts } from '../../worker/process.ts';

export class NativeBackend implements EditBackend {
  private readonly process: NativeProcess;
  private checked = false;
  private readonly model: LocalEditingModel;
  private readonly timeouts: WorkerTimeouts;
  constructor(executable: string, model: LocalEditingModel, timeouts: WorkerTimeouts) {
    this.process = new NativeProcess(executable, timeouts); this.model = model; this.timeouts = timeouts;
  }
  async inspect(signal?: AbortSignal): Promise<void> {
    if (this.checked) { checkSignal(signal); return; }
    await inspectNativeAssets(this.model, signal);
    const help = await this.process.run(['--help'], this.model.directory, this.timeouts.startupMs, signal, true);
    // Short hashes are how the upstream build stamps sd_commit(). Do not accept arbitrary binaries.
    const match = /^stable-diffusion\.cpp version [^\r\n]+, commit ([a-f0-9]{7,40})(?:\s|$)/m.exec(help);
    if (!match || !nativeRevision.startsWith(match[1]!)) throw new PicPatchSdkError('BACKEND_UNAVAILABLE', 'Use the documented stable-diffusion.cpp revision.');
    this.checked = true;
  }
  async validate(request: ImageRequest, options: OperationOptions = {}): Promise<ModelCapabilities> {
    const capabilities = nativeCapabilities(this.model.variant, this.model.manifest.model);
    if (/<lora:/i.test('prompt' in request ? request.prompt : request.instruction)) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'Prompt-embedded LoRA loading is unsupported; use prepareModel loras.');
    if ('prompt' in request) validateGenerateRequest(request, capabilities); else validateEditRequest(request, capabilities);
    if (request.control && (!this.model.controlNet || request.control.kind !== this.model.controlNet.kind)) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'Prepare the matching ControlNet asset before supplying a control map.');
    await this.inspect(options.signal);
    return capabilities;
  }
  generate(request: GenerateRequest, options: OperationOptions = {}): Promise<EditResult> { return this.execute(request, options); }
  edit(request: EditRequest, options: OperationOptions = {}): Promise<EditResult> { return this.execute(request, options); }
  private async execute(request: ImageRequest, options: OperationOptions): Promise<EditResult> {
    const capabilities = await this.validate(request, options);
    const effectiveParameters = resolveParameters(request.parameters, capabilities, 'prompt' in request ? 'generate' : 'edit');
    const seed = request.seed ?? randomInt(0x1_0000_0000);
    const size = request.size ?? capabilities.defaultOutputSize!;
    const directory = dirname(request.outputPath);
    let prompt = 'prompt' in request ? request.prompt : request.instruction;
    const group = 'instruction' in request ? request.references?.[0] : undefined;
    if (this.model.photoMaker && group) prompt = prompt.replace(`{${group.id}}`, `${group.className} img`);
    // Keep private text out of process arguments and disable native PNG metadata.
    try {
      for (const [index, lora] of (this.model.loras ?? []).entries()) {
        const alias = `adapter-${index}`;
        await symlink(join(this.model.directory, lora.path), join(directory, `${alias}.safetensors`));
        // Only generated aliases enter the CLI's prompt syntax; caller paths stay literal.
        prompt += ` <lora:${alias}:${lora.scale ?? 1}>`;
      }
      await writeFile(join(directory, 'prompt.txt'), prompt, { flag: 'wx', mode: 0o600 });
      checkSignal(options.signal);
      await writeFile(join(directory, 'negative.txt'), effectiveParameters.negativePrompt ?? '', { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      checkSignal(options.signal);
      throw new PicPatchSdkError('IMAGE_IO', 'Could not prepare private native input files.', { cause });
    }
    checkSignal(options.signal);
    const args = ['--model', join(this.model.directory, this.model.checkpoint!), '--prompt-file', 'prompt.txt', '--negative-prompt-file', 'negative.txt',
      // The pinned Metal GROUP_NORM kernel corrupts batched CFG (upstream issue #2149).
      '--batched-cfg', 'off', '--output', basename(request.outputPath), '--disable-image-metadata', '--log-level', 'error', '--batch-count', '1',
      '--width', String(size.width), '--height', String(size.height), '--seed', String(seed),
      '--steps', String(effectiveParameters.steps), '--cfg-scale', String(effectiveParameters.guidance),
      '--sampling-method', effectiveParameters.sampler!, '--scheduler', effectiveParameters.scheduler!, '--lora-model-dir', directory];
    if (this.model.loras) args.push('--lora-apply-mode', 'at_runtime');
    if (request.control) args.push('--control-net', join(this.model.directory, this.model.controlNet!.path), '--control-image', request.control.image, '--control-strength', String(request.control.strength ?? 0.9));
    if (this.model.vae) args.push('--vae', join(this.model.directory, this.model.vae));
    if ('instruction' in request && request.sourceImage) {
      args.push('--init-img', request.sourceImage!, '--strength', String(effectiveParameters.strength));
      if (request.maskImage) args.push('--mask', request.maskImage);
    }
    if (this.model.photoMaker && group) {
      try {
        const photos = join(directory, 'identity');
        await mkdir(photos, { mode: 0o700 });
        const digits = String(group.images.length).length;
        for (const [index, path] of group.images.entries()) {
          checkSignal(options.signal);
          await copyFile(path, join(photos, `${String(index).padStart(digits, '0')}.png`));
        }
        // Upstream selects V2 by substring in the passed path, even parent directories.
        // A fixed relative alias selects V1 without copying multi-GB weights.
        await symlink(join(this.model.directory, this.model.photoMaker), join(directory, 'photomaker-v1.safetensors'));
        // Metal cannot perform the pinned runtime's in-place F16 LoRA merge.
        // Apply PhotoMaker's required LoRA during inference instead.
        args.push('--lora-apply-mode', 'at_runtime', '--photo-maker', 'photomaker-v1.safetensors', '--pm-id-images-dir', photos, '--pm-style-strength', String(effectiveParameters.identityStyleStrength));
      } catch (cause) {
        checkSignal(options.signal);
        throw new PicPatchSdkError('IMAGE_IO', 'Could not prepare private identity inputs.', { cause });
      }
    } else if (this.model.ipAdapter && group) {
      args.push('--ip-adapter', join(this.model.directory, this.model.ipAdapter), '--clip_vision', join(this.model.directory, this.model.clipVision!), '--ip-adapter-image', group.images[0], '--ip-adapter-strength', String(effectiveParameters.appearanceStrength));
    }
    const verb = 'prompt' in request ? 'generate' : 'edit';
    emitProgress(options, { type: 'progress', verb, stage: verb === 'generate' ? 'generating' : 'editing', message: 'Running native image inference.' });
    await this.process.run(args, directory, verb === 'generate' ? this.timeouts.generateMs ?? this.timeouts.editMs : this.timeouts.editMs, options.signal);
    emitProgress(options, { type: 'progress', verb, stage: 'saving', message: 'Validating native image output.' });
    return { model: request.model, modelRevision: this.model.manifest.source.revision, runtime: { name: 'stable-diffusion.cpp', version: nativeRevision },
      seed, effectiveParameters,
      ...(request.control ? { control: { kind: request.control.kind, strength: request.control.strength ?? 0.9, asset: { filename: basename(this.model.controlNet!.path), sha256: this.model.manifest.components.find(component => component.path === this.model.controlNet!.path)!.sha256 } } } : {}),
      ...(this.model.loras ? { loras: this.model.loras.map(lora => ({ filename: basename(lora.path), scale: lora.scale ?? 1, sha256: this.model.manifest.components.find(component => component.path === lora.path)!.sha256 })) } : {}),
      ...(this.model.photoMaker || this.model.ipAdapter ? { conditioning: { method: this.model.photoMaker ? 'photomaker-v1' as const : this.model.variant.endsWith('-plus') ? 'ip-adapter-plus' as const : 'ip-adapter' as const, assets: (['photoMaker', 'ipAdapter', 'clipVision'] as const).flatMap(role => this.model[role] ? [{ role, filename: basename(this.model[role]!), sha256: this.model.manifest.components.find(component => component.path === this.model[role])!.sha256 }] : []) } } : {}),
      image: { path: request.outputPath, mimeType: 'image/png', size }, references: [] };
  }
  dispose(): Promise<void> { return this.process.dispose(); }
}
