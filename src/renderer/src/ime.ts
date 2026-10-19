/** Menu commands have no KeyboardEvent, so retain composition through the commit frame. */
let composing = false;
let ending: number | undefined;
document.addEventListener('compositionstart', () => { if (ending !== undefined) cancelAnimationFrame(ending); composing = true; });
document.addEventListener('compositionend', () => { ending = requestAnimationFrame(() => { composing = false; ending = undefined; }); });
export function isComposing(event?: KeyboardEvent): boolean { return composing || event?.isComposing === true || event?.keyCode === 229; }
