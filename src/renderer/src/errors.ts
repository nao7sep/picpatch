// The renderer's last-resort failures go to Records through main, so a crash is never only a console line.
export function reportRendererErrors(report: (error: { message: string; stack?: string }) => Promise<void>) {
  const send = (value: unknown) => {
    const error = value instanceof Error ? value : new Error(String(value));
    void report({ message: error.message, ...(error.stack ? { stack: error.stack } : {}) }).catch(() => {});
  };
  window.addEventListener('error', event => send(event.error ?? event.message));
  window.addEventListener('unhandledrejection', event => send(event.reason));
}
