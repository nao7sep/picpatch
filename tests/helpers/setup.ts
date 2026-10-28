// Every rendering test also proves that no message key reaches the screen untranslated.
import { configure } from '@testing-library/dom';
import { afterEach, expect } from 'vitest';
import { leakedMessages } from './rendered-messages.ts';
// Tests carry no timeouts: waitFor and findBy wait until what they look for appears.
configure({ asyncUtilTimeout: 2 ** 31 - 1 });
afterEach(() => { if (typeof document !== 'undefined' && document.body) expect(leakedMessages(document.body)).toEqual([]); });
