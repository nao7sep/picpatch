// Every rendering test also proves that no message key reaches the screen untranslated.
import { afterEach, expect } from 'vitest';
import { leakedMessages } from './rendered-messages.ts';
afterEach(() => { if (typeof document !== 'undefined' && document.body) expect(leakedMessages(document.body)).toEqual([]); });
