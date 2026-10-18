import { resolve } from 'node:path';
import { validateEditRequest, type EditRequest } from 'picpatchsdk';

// Shape-only example: these paths are illustrative and no files are opened.
const request = {
  model: 'model-to-be-selected-after-evaluation',
  instruction: 'Place both subjects together at a science fair beside a cardboard robot.',
  outputPath: resolve('edited.png'),
  references: [
    { id: 'alice', role: 'subject', images: [resolve('alice-front.png'), resolve('alice-side.png')] },
    { id: 'bob', role: 'subject', images: [resolve('bob-front.png'), resolve('bob-side.png')] },
  ],
} satisfies EditRequest;

console.log(JSON.stringify(validateEditRequest(request), null, 2));
