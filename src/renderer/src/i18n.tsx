// The interface language as React context. The shared catalogue module holds the
// loaded language; the context revision makes every reader render again when it changes.
import { createContext, useContext } from 'react';
import { t, term, number, errorText, activeLocale } from '../../shared/i18n/index.ts';

const Revision = createContext(0);
export const LanguageRevision = Revision.Provider;

export function useI18n() {
  useContext(Revision);
  return { t, term, number, errorText, locale: activeLocale() };
}
