import type { EditRequest } from 'picpatch';

// Shape-only example: these paths are illustrative and no files are opened.
const request = {
  model: 'model-to-be-selected-after-evaluation',
  instruction: 'Place both subjects together at a science fair beside a cardboard robot.',
  references: [
    { id: 'alice', role: 'subject', images: ['alice-front.png', 'alice-side.png'] },
    { id: 'bob', role: 'subject', images: ['bob-front.png', 'bob-side.png'] },
  ],
} satisfies EditRequest;

console.log(JSON.stringify(request, null, 2));
