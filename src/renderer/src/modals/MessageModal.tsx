// The app's one queued message surface: main's questions (delete, download, quit)
// and the renderer's own confirmations. Dismissal resolves undefined, never consent.
import { useCallback, useRef, useState } from 'react';
import type { AppMessage } from '../../../shared/messages.ts';
import type { Message } from '../../../shared/i18n/index.ts';
import { useI18n } from '../i18n.tsx';
import { Modal } from './Modal.tsx';

interface Pending { message: AppMessage; resolve: (answer: number | undefined) => void }

export function useMessages() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const queueRef = useRef(queue); queueRef.current = queue;
  const ask = useCallback((message: AppMessage) => new Promise<number | undefined>(resolve => { setQueue(items => [...items, { message, resolve }]); }), []);
  // A second click before React re-renders must not answer, or drop, the next question.
  const answered = useRef(new WeakSet<Pending>());
  const answer = useCallback((value: number | undefined) => {
    const first = queueRef.current.find(item => !answered.current.has(item));
    if (!first) return;
    answered.current.add(first); first.resolve(value);
    setQueue(items => items.filter(item => item !== first));
  }, []);
  const dismissAll = useCallback(() => { for (const item of queueRef.current) if (!answered.current.has(item)) { answered.current.add(item); item.resolve(undefined); } setQueue([]); }, []);
  return { current: queue[0], ask, answer, dismissAll };
}

export function MessageModal({ message, onAnswer }: { message: AppMessage; onAnswer: (answer: number | undefined) => void }) {
  const { t } = useI18n();
  const text = (value: Message) => t(value.key, value.values);
  const [dismiss, ...actions] = message.actions;
  const detailId = 'message-detail';
  return (
    <Modal
      title={text(message.title)} width={420} guarded describedBy={message.detail ? detailId : undefined}
      onClose={() => onAnswer(undefined)}
      footer={<>
        <button type="button" className="button" data-autofocus={actions.some(action => action.destructive) ? 'true' : undefined} onClick={() => onAnswer(undefined)}>{dismiss ? text(dismiss.label) : t('ui.close')}</button>
        {actions.map((action, index) => (
          <button key={index} type="button" className={`button ${action.destructive ? 'danger' : 'primary'}`} data-destructive={action.destructive ? 'true' : undefined} onClick={() => onAnswer(index + 1)}>
            {text(action.label)}
          </button>
        ))}
      </>}
    >
      {message.detail ? <p id={detailId} className="message-detail">{text(message.detail)}</p> : null}
    </Modal>
  );
}
