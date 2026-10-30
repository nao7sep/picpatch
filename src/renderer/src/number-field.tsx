// Fields where the user types a number. The field keeps exactly what was typed; a value
// it cannot use shows what it accepts under the field, nothing is committed meanwhile,
// and the action using it waits. What was typed outlives the field (the options pane or
// the size popover closing), so a blocked Send always has its reason in the composer.
import { createContext, useContext, useId, type ReactNode } from 'react';
import { message, t, type Message } from '../../shared/i18n/index.ts';

export type NumberRule = { whole?: boolean; min?: number; max?: number; multiple?: number; empty?: boolean };

/** A maximum this large is still checked but not worth reading out. */
const SHOWN_MAXIMUM = 1e15;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** What the field accepts, said as one instruction. */
function accepts(rule: NumberRule): Message {
  if (rule.multiple !== undefined) return message('field.multiple', { multiple: rule.multiple });
  const max = rule.max !== undefined && rule.max < SHOWN_MAXIMUM ? rule.max : undefined;
  if (rule.min !== undefined && max !== undefined) return message(rule.whole ? 'field.whole_range' : 'field.number_range', { min: rule.min, max });
  if (rule.min !== undefined) return message(rule.whole ? 'field.whole_min' : 'field.number_min', { min: rule.min });
  return message('field.number');
}

/** The value typed text stands for (undefined for an allowed empty field), or what the field accepts. */
export function checkNumber(text: string, rule: NumberRule): { value: number | undefined } | { error: Message } {
  const typed = text.trim();
  if (!typed) return rule.empty ? { value: undefined } : { error: accepts(rule) };
  const value = Number(typed);
  if (!NUMBER.test(typed) || !Number.isFinite(value)
    || ((rule.whole || rule.multiple !== undefined) && !Number.isSafeInteger(value))
    || (rule.multiple !== undefined && (value < rule.multiple || value % rule.multiple !== 0))
    || (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) return { error: accepts(rule) };
  return { value };
}

/** Typed text that differs from the committed value: an unusable value, or a usable one written differently. */
export type FieldEdit = { text: string; label: string; value?: number; error?: Message };
export type FieldEdits = { edits: Readonly<Record<string, FieldEdit>>; edit: (id: string, edit: FieldEdit | undefined) => void };
const Edits = createContext<FieldEdits>({ edits: {}, edit: () => {} });
export const NumberFields = ({ value, children }: { value: FieldEdits; children: ReactNode }) => <Edits.Provider value={value}>{children}</Edits.Provider>;

/** The first unusable field among those that still apply, as the reason an action waits. */
export function fieldProblem(edits: Readonly<Record<string, FieldEdit>>, applies: (id: string) => boolean = () => true): string | undefined {
  const entry = Object.entries(edits).find(([id, edit]) => edit.error && applies(id));
  return entry && t('composer.field', { field: entry[1].label, problem: entry[1].error! });
}

export function NumberField({ id, label, value, rule, onCommit, placeholder, className = 'field compact', inputClassName, hideLabel }: {
  id: string; label: string; value: number | undefined; rule: NumberRule; onCommit: (value: number | undefined) => void;
  placeholder?: string; className?: string; inputClassName?: string; hideLabel?: boolean;
}) {
  const { edits, edit } = useContext(Edits);
  const inputId = useId(), errorId = useId();
  const entry = edits[id];
  // A usable edit shows only while it still stands for the committed value; a change made elsewhere replaces it.
  const text = entry && (entry.error || entry.value === value) ? entry.text : value === undefined ? '' : String(value);
  const change = (typed: string) => {
    const checked = checkNumber(typed, rule);
    if ('error' in checked) { edit(id, { text: typed, label, error: checked.error }); return; }
    edit(id, { text: typed, label, ...(checked.value === undefined ? {} : { value: checked.value }) });
    if (checked.value !== value) onCommit(checked.value);
  };
  const input = (
    <input
      id={inputId} type="text" inputMode={rule.whole || rule.multiple !== undefined ? 'numeric' : 'decimal'} className={inputClassName} value={text} placeholder={placeholder}
      aria-label={hideLabel ? label : undefined} aria-invalid={entry?.error ? true : undefined} aria-describedby={entry?.error ? errorId : undefined}
      onChange={event => change(event.target.value)}
    />
  );
  const problem = entry?.error && <span id={errorId} className="field-error">{t(entry.error.key, entry.error.values)}</span>;
  // The problem sits outside the label, so it describes the field without becoming part of its name.
  return hideLabel ? <span className={className}>{input}{problem}</span> : <div className={className}><label className="field-label" htmlFor={inputId}>{label}</label>{input}{problem}</div>;
}
