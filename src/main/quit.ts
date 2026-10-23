/** One owner for ordinary close/quit and OS takeover; UI decisions have no save timer. */
export function quitFlow(port: {
  freeze(value: boolean): void;
  flush(): Promise<void>;
  drafts(): Promise<boolean>;
  saveFailure(error: unknown): Promise<number | undefined>;
  work(): Promise<boolean>;
  settle?(): Promise<void>;
  finish(abandon?: boolean): Promise<void>;
  failed(error: unknown): Promise<void>;
  interrupt(): void;
  shutdownSave(): Promise<void>;
  exit(): void;
  /** Ends the process without entering cleanup that a call stuck in native I/O would hold. */
  forceExit(): void;
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
          let abandon = false;
          for (;;) {
            try { await port.settle?.(); break; }
            catch (error) {
              if (shutdown) return;
              const answer = await port.saveFailure(error);
              if (shutdown || answer === undefined || answer === 0) return;
              if (answer === 2) { abandon = true; break; }
            }
          }
          if (!shutdown) await port.finish(abandon);
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
      const deadline = setTimeout(() => { if (!exited) { exited = true; port.forceExit(); } }, 1000);
      void port.shutdownSave().catch(() => {}).finally(() => { clearTimeout(deadline); if (!exited) { exited = true; port.exit(); } });
    },
  };
}
