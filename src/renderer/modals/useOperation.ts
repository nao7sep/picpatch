// One resource operation at a time in a surface: its busy state, its failure as the
// surface's own result, and Cancel through main's managed-operation abort.
import { useCallback, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';

export function useOperation() {
  const { errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const busyRef = useRef(false);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true; setBusy(true); setFailure(undefined);
    try {
      const result = await work();
      const refused = result && typeof result === 'object' && (result as { status?: string }).status === 'refused';
      if (refused) setFailure(errorText(result));
      return result;
    } catch (error) { setFailure(errorText(error)); return undefined; }
    finally { busyRef.current = false; setBusy(false); }
  }, [errorText]);
  const cancel = useCallback(() => { void api.cancelManaged().catch(error => setFailure(errorText(error))); }, [errorText]);
  return { busy, failure, setFailure, run, cancel };
}
