/** Launcher-owned processes settle before shutdown; ordinary stops retain their signal status. */
export const stopCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
export function launcherLifecycle({ signals = process, exit = code => process.exit(code), timeout = 60_000 } = {}) {
  const children = new Map(); const cleanup = new Set();
  let stopping = false; let settlement;
  function track(child) {
    const done = new Promise(resolve => {
      child.once('close', resolve);
      child.once('error', resolve);
    });
    children.set(child, done);
    void done.then(() => children.delete(child));
    if (stopping) child.kill('SIGTERM');
    return child;
  }
  function stop(signal) {
    if (settlement) return settlement;
    stopping = true;
    for (const close of cleanup) close();
    settlement = (async () => {
      for (const child of children.keys()) child.kill('SIGTERM');
      let timer;
      try {
        await Promise.race([
          Promise.all(children.values()),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PicPatch did not finish closing. It was not forced to quit.')), timeout); }),
        ]);
        exit(stopCodes[signal]);
      } catch (error) { console.error(error); exit(1); }
      finally { clearTimeout(timer); }
    })();
    return settlement;
  }
  for (const signal of Object.keys(stopCodes)) signals.on(signal, () => { void stop(signal); });
  return { track, stop, cleanup, get stopping() { return stopping; } };
}

/** Both the app and its supervising watcher belong to a launch mode. */
export function launcherPids(output, launcher, ownPid) {
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || Number(match[1]) === ownPid) return [];
    const command = match[2];
    return /^(?:\S*\/)?node(?:\.exe)?\s/.test(command) && command.endsWith(`${launcher} dev`) ? [Number(match[1])] : [];
  });
}
