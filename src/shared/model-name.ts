/** Product tokens are names; translated state and explanatory text are added by the UI. */
export function modelName(id: string): string {
  const names: Record<string, string> = { flux1: 'FLUX.1', flux2: 'FLUX.2', sdxl: 'SDXL', sd15: 'SD 1.5', sd35: 'SD 3.5', qwen: 'Qwen', klein: 'Klein', glm: 'GLM', z: 'Z', lcm: 'LCM' };
  return id.split('-').map(token => names[token] ?? (/^\d+b$/.test(token) ? token.toUpperCase() : /^\d+bit$/.test(token) ? token.replace('bit', '-bit') : token.charAt(0).toUpperCase() + token.slice(1))).join(' ');
}
