import {useEffect, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode} from 'react';
import type {ActionPreviewTarget} from '../shared/model';
import {Icon} from './App';
import {PixelFlower} from './Pixel';

export type PlannerPreviewTarget = ActionPreviewTarget & {calendarDeadline?: boolean};

export function Button({children, icon, variant = 'outline', className = '', ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: string; variant?: 'primary' | 'outline' | 'ghost';
}) {
  return <button type="button" {...props} className={`btn btn-${variant} ${className}`}>
    {icon && <Icon name={icon} size={16}/>}<span>{children}</span>
  </button>;
}

export function Modal({title, onClose, children, footer, onSubmit}: {
  title: string; onClose: () => void; children: ReactNode; footer: ReactNode; onSubmit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lastFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    lastFocus.current = document.activeElement;
    element.showModal();
    element.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      element.close();
      if (lastFocus.current instanceof HTMLElement && lastFocus.current.isConnected) lastFocus.current.focus({preventScroll: true});
    };
  }, []);
  return <dialog ref={dialog} className="dialog bloom-editor" aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const {left, right, top, bottom} = event.currentTarget.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) onClose();
    }}>
    <form onSubmit={event => {event.preventDefault(); onSubmit();}}>
      <div className="dialog-head">
        <div className="dialog-title"><PixelFlower size={25}/><h2>{title}</h2></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button>
      </div>
      <div className="dialog-body">{children}</div>
      <div className="dialog-footer">{footer}</div>
    </form>
  </dialog>;
}

export function Field({label, children, full = false}: {label: string; children: ReactNode; full?: boolean}) {
  return <label className={`field ${full ? 'full-field' : ''}`}><span className="field-label">{label}</span>{children}</label>;
}

export function TaskCheck({checked, label, onChange, disabled}: {
  checked: boolean; label: string; onChange: () => void; disabled?: boolean;
}) {
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={label}
    className={`task-checkbox ${checked ? 'is-checked' : ''}`} onClick={onChange} disabled={disabled}>
    {checked && <Icon name="check" size={13} stroke={3}/>}
  </button>;
}

export function previewClass(target: ActionPreviewTarget | null, entity: ActionPreviewTarget['entity'], id: string) {
  if (!target) return '';
  if (target.entity === entity && target.id === id) return target.before ? ' bloom-preview-focus bloom-preview-deleted' : ' bloom-preview-focus';
  return ' bloom-preview-dim';
}

export function useEscape(action: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) action();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [action, enabled]);
}
