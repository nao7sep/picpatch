interface LayoutElement {
  textContent: string | null;
  scrollWidth: number; clientWidth: number;
  ownerDocument: { activeElement: unknown };
  querySelector(selector: string): LayoutElement | null;
  querySelectorAll(selector: string): ArrayLike<LayoutElement>;
  getBoundingClientRect(): { top: number; bottom: number };
  getClientRects(): { length: number };
  contains(element: any): boolean;
  focus(): void; click(): void;
}
/** Runs inside the qualification renderer so every tab is checked while its content is mounted. */
export async function modalLayoutProblems(dialog: LayoutElement, settle: () => Promise<void>, viewportHeight: number): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string) => {
    const add = (problem: string) => failures.push(`${label}: ${problem}`);
    const bands = ['.modal-head', '.modal-body', '.modal-foot'].map(selector => dialog.querySelector(selector)?.getBoundingClientRect()).filter((band): band is { top: number; bottom: number } => !!band);
    for (let i = 1; i < bands.length; i++) if (bands[i - 1]!.bottom > bands[i]!.top + 2) add('bands overlap');
    if (bands.at(-1) && bands.at(-1)!.bottom > viewportHeight + 1) add('footer left viewport');
    if (dialog.scrollWidth > dialog.clientWidth + 2) add('horizontal overflow');
    for (const control of Array.from(dialog.querySelectorAll('button, .menu-item, .chip-button, .segmented label, .tab-strip button'))) {
      if (control.getClientRects().length && control.scrollWidth > control.clientWidth + 2) add('clipped ' + control.textContent?.trim());
    }
    if (!dialog.contains(dialog.ownerDocument.activeElement)) add('focus outside modal');
  };
  // Clicking a tab can replace its siblings, so retain indices and reacquire each current control.
  const count = dialog.querySelectorAll('[role="tab"]').length;
  if (!count) { await settle(); check('dialog'); }
  for (let index = 0; index < count; index++) {
    const tab = dialog.querySelectorAll('[role="tab"]')[index]!;
    const label = tab.textContent?.trim() || `tab ${index + 1}`;
    tab.focus(); tab.click(); await settle(); check(label);
  }
  return failures;
}
