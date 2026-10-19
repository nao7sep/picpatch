/** Authored text, file names, paths and diagnostics are literal content and may look like anything. */
const literal = '.command-text, .session-title, .title-text, .chip-name, .path-value, .record-text, .records-block, .export-name, .picker-name, .composer-field';
const key = /^(?:about|admission|class|collection|component|composer|conditioning|control|conversation|error|evidence|export|licence|logs|management|mask|memory|model|native|options|parameter|purpose|quit|rail|reference|rename|role|run|session|settings|setup|shortcuts|speed|stage|status|ui|viewer)\.[A-Za-z][\w.]*$/;
export function leakedMessages(root: HTMLElement): string[] {
  const leaks: string[] = [];
  function visit(element: Element) {
    if (element.matches(literal)) return;
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) { const text = element.getAttribute(attribute)?.trim(); if (text && key.test(text)) leaks.push(text); }
    for (const node of element.childNodes) {
      if (node.nodeType === 3) { const text = node.textContent?.trim(); if (text && key.test(text)) leaks.push(text); }
      else if (node.nodeType === 1) visit(node as Element);
    }
  }
  visit(root); return leaks;
}
