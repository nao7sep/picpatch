import { randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { EditBackend } from '../../execution/backend.ts';
import type { LocalEditingModel, ModelCapabilities } from '../../contracts.generated.ts';
import type { ImageRequest, EditRequest, GenerateRequest, EditResult, OperationOptions } from '../../types.ts';
import { validateEditRequest, validateGenerateRequest } from '../../validation.ts';
import { resolveParameters } from '../../parameters.ts';
import { checkSignal, emitProgress } from '../../operations.ts';
import { PicPatchRuntimeError, PicPatchUsageError } from '../../errors.ts';
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
    const help = await this.process.run(['--help'], this.model.directory, this.timeouts.startupMs, signal, true);
    // Short hashes are how the upstream build stamps sd_commit(). Do not accept arbitrary binaries.
    const match = /^stable-diffusion\.cpp version [^\r\n]+, commit ([a-f0-9]{7,40})(?:\s|$)/m.exec(help);
    if (!match || !nativeRevision.startsWith(match[1]!)) throw new PicPatchRuntimeError('BACKEND_UNAVAILABLE', 'Use the documented stable-diffusion.cpp revision.');
    this.checked = true;
  }
  async validate(request: ImageRequest, options: OperationOptions = {}): Promise<ModelCapabilities> {
    const capabilities = nativeCapabilities(this.model.variant, this.model.manifest.model);
    if (/<lora:/i.test('prompt' in request ? request.prompt : request.instruction)) throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'Prompt-embedded LoRA loading is unsupported; use prepared model assets.');
    if ('prompt' in request) validateGenerateRequest(request, capabilities); else validateEditRequest(request, capabilities);
    await this.inspect(options.signal);
    return capabilities;
  }
  generate(request: GenerateRequest, options: OperationOptions = {}): Promise<EditResult> { return this.execute(request, options); }
  edit(request: EditRequest, options: OperationOptions = {}): Promise<EditResult> { return this.execute(request, options); }
  private async execute(request: ImageRequest, options: OperationOptions): Promise<EditResult> {
    const capabilities = await this.validate(request, options);
    const effectiveParameters = resolveParameters(request.parameters, capabilities);
    const seed = request.seed ?? randomInt(0x1_0000_0000);
    const size = request.size ?? capabilities.defaultOutputSize!;
    const directory = dirname(request.outputPath);
    const prompt = 'prompt' in request ? request.prompt : request.instruction;
    // Keep private text out of process arguments and disable native PNG metadata.
    try {
      await writeFile(join(directory, 'prompt.txt'), prompt, { flag: 'wx', mode: 0o600 });
      checkSignal(options.signal);
      await writeFile(join(directory, 'negative.txt'), effectiveParameters.negativePrompt ?? '', { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      checkSignal(options.signal);
      throw new PicPatchRuntimeError('IMAGE_IO', 'Could not prepare private native input files.', { cause });
    }
    checkSignal(options.signal);
    const args = ['--model', join(this.model.directory, this.model.checkpoint!), '--prompt-file', 'prompt.txt', '--negative-prompt-file', 'negative.txt',
      '--output', basename(request.outputPath), '--disable-image-metadata', '--log-level', 'error', '--batch-count', '1',
      '--width', String(size.width), '--height', String(size.height), '--seed', String(seed),
      '--steps', String(effectiveParameters.steps), '--cfg-scale', String(effectiveParameters.guidance),
      '--sampling-method', effectiveParameters.sampler!, '--scheduler', effectiveParameters.scheduler!, '--lora-model-dir', directory];
    if (this.model.vae) args.push('--vae', join(this.model.directory, this.model.vae));
    if ('instruction' in request) args.push('--init-img', request.sourceImage!, '--mask', request.maskImage!, '--strength', String(effectiveParameters.strength));
    const verb = 'prompt' in request ? 'generate' : 'edit';
    emitProgress(options, { type: 'progress', verb, stage: verb === 'generate' ? 'generating' : 'editing', message: 'Running native image inference.' });
    await this.process.run(args, directory, verb === 'generate' ? this.timeouts.generateMs ?? this.timeouts.editMs : this.timeouts.editMs, options.signal);
    emitProgress(options, { type: 'progress', verb, stage: 'saving', message: 'Validating native image output.' });
    return { model: request.model, modelRevision: this.model.manifest.source.revision, runtime: { name: 'stable-diffusion.cpp', version: nativeRevision },
      seed, effectiveParameters, image: { path: request.outputPath, mimeType: 'image/png', size }, references: [] };
  }
  dispose(): Promise<void> { return this.process.dispose(); }
}
