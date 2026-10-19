/** User-authored names, file labels and raw diagnostics are literal-content boundaries. */
const literal = '#sessionList, #sourceName, #controlName, #recordLines, #resultInfo, #issue';
const key = /^(?:ui|native|settings|session|reference|parameter|role|conditioning|class|component|status|stage|management|admission|run|common|error)\.[A-Za-z][\w.]*$/;
export function leakedMessages(root: HTMLElement): string[] {
  const leaks: string[] = [];
  function visit(element: Element) {
    if (element.matches(literal)) return;
    for (const attribute of ['title','aria-label','placeholder','alt']) { const text = element.getAttribute(attribute)?.trim(); if (text && key.test(text)) leaks.push(text); }
    for (const node of element.childNodes) {
      if (node.nodeType === 3) { const text = node.textContent?.trim(); if (text && key.test(text)) leaks.push(text); }
      else if (node.nodeType === 1) visit(node as Element);
    }
  }
  visit(root); return leaks;
}
