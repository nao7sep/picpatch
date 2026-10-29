const closeDeadline = 5000, shutdownDeadline = 1000;
/**
 * One owner for ordinary close/quit and OS takeover. Each holds one exit deadline that every step draws on; a quit
 * question pauses it, and it starts again when the answer arrives. UI decisions have no timer of their own.
 */
export function quitFlow(port: {
  freeze(value: boolean): void;
  /** Saves the editor within the time that remains. */
  flush(remaining: number): Promise<void>;
  drafts(): Promise<boolean>;
  saveFailure(error: unknown): Promise<number | undefined>;
  work(): Promise<boolean>;
  finish(): Promise<void>;
  failed(error: unknown): Promise<void>;
  interrupt(): void;
  /** Saves the editor and stops the store workers, skipping pending backup captures. */
  shutdownSave(): Promise<void>;
  quit(): void;
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
      let ends = Date.now() + closeDeadline;
      const restart = () => { ends = Date.now() + closeDeadline; };
      attempt = (async () => {
        port.freeze(true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          for (;;) {
            try { await port.flush(Math.max(0, ends - Date.now())); break; }
            catch (error) {
              if (shutdown) return;
              const answer = await port.saveFailure(error);
              restart();
              if (shutdown || answer === undefined || answer === 0) return;
              if (answer === 2) break;
            }
          }
          // The work and draft steps only ask the user, so the deadline starts again after them.
          if (shutdown || !await port.work() || shutdown) return;
          if (!await port.drafts() || shutdown) return;
          restart();
          // A step still stuck in native I/O would also hold Electron's own exit, so the deadline stays armed through it.
          timer = setTimeout(() => port.forceExit(), Math.max(0, ends - Date.now()));
          await port.finish();
          if (!shutdown) port.quit();
        } catch (error) { clearTimeout(timer); if (!shutdown) await port.failed(error); }
        finally { if (!shutdown) port.freeze(false); }
      })().finally(() => { attempt = undefined; });
      return attempt;
    },
    shutdown() {
      if (shutdown) return;
      shutdown = true;
      port.interrupt();
      // Neither a stuck renderer nor cleanup may extend the total, so the deadline stays armed through the exit.
      let exited = false;
      // An exit already under way that has not ended the process by then is forced too.
      setTimeout(() => { exited = true; port.forceExit(); }, shutdownDeadline);
      void port.shutdownSave().catch(() => {}).finally(() => { if (!exited) { exited = true; port.exit(); } });
    },
  };
}
