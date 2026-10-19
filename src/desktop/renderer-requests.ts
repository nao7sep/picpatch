import type { RendererRequest, RendererReply } from '../shared/messages.ts';
/** Correlate replies so a late timed-out save cannot settle a later request. */
export function rendererRequests(send: (id: number, request: RendererRequest) => void) {
  let next = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  function cancelAll() {
    for (const item of pending.values()) item.reject(new Error('Renderer request interrupted.'));
    pending.clear();
  }
  return {
    request(request: RendererRequest, timeout?: number): Promise<any> {
      const id = ++next;
      let timer: ReturnType<typeof setTimeout> | undefined;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        if (timeout !== undefined) timer = setTimeout(() => {
          pending.delete(id); reject(new Error('Renderer did not settle the request.'));
        }, timeout);
        try { send(id, request); } catch (error) { pending.delete(id); reject(error); }
      }).finally(() => { clearTimeout(timer); });
    },
    reply(reply: RendererReply) {
      const item = pending.get(reply.id); if (!item) return;
      pending.delete(reply.id);
      if (reply.ok) item.resolve(reply.value); else item.reject(new Error(reply.message));
    },
    cancelAll,
  };
}
