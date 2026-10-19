/** One owner for ordinary close/quit and OS takeover; UI decisions have no save timer. */
export function quitFlow(port: {
  freeze(value: boolean): void;
  flush(): Promise<void>;
  drafts(): Promise<boolean>;
  saveFailure(error: unknown): Promise<number | undefined>;
  work(): Promise<boolean>;
  finish(): Promise<void>;
  failed(error: unknown): Promise<void>;
  interrupt(): void;
  shutdownSave(): Promise<void>;
  exit(): void;
}) {
  let attempt: Promise<void> | undefined;
  let shutdown = false;
  return {
    close(): Promise<void> {
      if (shutdown) return Promise.resolve();
      if (attempt) return attempt;
      attempt = (async () => {
        port.freeze(true);
        try {
          for (;;) {
            try { await port.flush(); break; }
            catch (error) {
              if (shutdown) return;
              const answer = await port.saveFailure(error);
              if (shutdown || answer === undefined || answer === 0) return;
              if (answer === 2) break;
            }
          }
          if (shutdown || !await port.work() || shutdown) return;
          if (!await port.drafts() || shutdown) return;
          await port.finish();
        } catch (error) { if (!shutdown) await port.failed(error); }
        finally { if (!shutdown) port.freeze(false); }
      })().finally(() => { attempt = undefined; });
      return attempt;
    },
    shutdown() {
      if (shutdown) return;
      shutdown = true;
      port.interrupt();
      // One total budget; neither a stuck renderer nor cleanup may extend it.
      let exited = false;
      const exit = () => { if (!exited) { exited = true; port.exit(); } };
      const deadline = setTimeout(exit, 1000);
      void port.shutdownSave().catch(() => {}).finally(() => { clearTimeout(deadline); exit(); });
    },
  };
}
