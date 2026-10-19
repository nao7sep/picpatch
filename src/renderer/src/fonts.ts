// The interface font from Settings, applied as the tokens' variable (app-chrome-conventions).
import { defaultFont, fixedFont } from '../../shared/appearance.ts';

export function applyFont(uiFont: string | undefined) {
  const style = document.documentElement.style;
  style.setProperty('--font-ui', uiFont?.trim() || defaultFont);
  style.setProperty('--font-mono', fixedFont);
}
