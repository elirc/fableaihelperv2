import type { SessionState } from '../../shared/domain';
import { isActivePhase } from './sessionMachine';

/**
 * Keyboard shortcut resolution for the coach window, kept pure so the
 * key→action mapping is unit-testable. The component layer decides what an
 * action does; this layer decides only whether a keystroke means one in the
 * current phase.
 *
 * Ctrl/Cmd+L      toggle Listen / Stop & respond
 * Escape          cancel the active session
 * Ctrl/Cmd+Shift+C copy the answer (plain Ctrl+C is never intercepted)
 */

export type ShortcutAction =
  | 'start-listening'
  | 'stop-listening'
  | 'cancel'
  | 'copy-answer'
  /** Escape inside an editable field: leave the field, so the next Escape cancels. */
  | 'leave-field';

export interface ShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Held-key auto-repeat; a repeat is never a fresh intent. */
  repeat?: boolean;
  /** The focused element; Escape inside an editable text field leaves the field first. */
  target?: EventTarget | null;
}

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'range', 'submit']);

/** Duck-typed so it runs without a DOM: an editable text input, textarea, or
 *  editable region. A read-only field (the transcript while busy) does not
 *  own Escape, so cancelling from the keyboard still works when it has focus. */
function isEditableTextField(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: string;
    type?: string;
    isContentEditable?: boolean;
    readOnly?: boolean;
    disabled?: boolean;
  };
  if (el.readOnly === true || el.disabled === true) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable === true) return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has(el.type ?? 'text');
}

export function resolveShortcut(input: ShortcutInput, phase: SessionState): ShortcutAction | null {
  if (input.altKey || input.repeat) return null;
  const primary = input.ctrlKey || input.metaKey;
  const key = input.key.toLowerCase();

  if (key === 'escape' && !primary && !input.shiftKey) {
    if (isEditableTextField(input.target)) return 'leave-field';
    return isActivePhase(phase) ? 'cancel' : null;
  }
  if (key === 'l' && primary && !input.shiftKey) {
    if (phase === 'recording') return 'stop-listening';
    if (phase === 'ready' || phase === 'complete' || phase === 'failed') return 'start-listening';
    return null;
  }
  if (key === 'c' && primary && input.shiftKey) {
    return 'copy-answer';
  }
  return null;
}
