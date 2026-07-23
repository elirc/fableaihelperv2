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

export type ShortcutAction = 'start-listening' | 'stop-listening' | 'cancel' | 'copy-answer';

export interface ShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function resolveShortcut(input: ShortcutInput, phase: SessionState): ShortcutAction | null {
  if (input.altKey) return null;
  const primary = input.ctrlKey || input.metaKey;
  const key = input.key.toLowerCase();

  if (key === 'escape' && !primary && !input.shiftKey) {
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
