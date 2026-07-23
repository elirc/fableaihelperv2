import { describe, expect, it } from 'vitest';
import type { SessionState } from '../../src/shared/domain';
import { resolveShortcut, type ShortcutInput } from '../../src/renderer/state/shortcuts';

function key(partial: Partial<ShortcutInput>): ShortcutInput {
  return { key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...partial };
}

const CTRL_L = key({ key: 'l', ctrlKey: true });
const META_L = key({ key: 'l', metaKey: true });
const ESCAPE = key({ key: 'Escape' });
const CTRL_SHIFT_C = key({ key: 'C', ctrlKey: true, shiftKey: true });

describe('resolveShortcut: Ctrl/Cmd+L listen toggle', () => {
  it('starts listening from the idle phases', () => {
    for (const phase of ['ready', 'complete', 'failed'] as SessionState[]) {
      expect(resolveShortcut(CTRL_L, phase)).toBe('start-listening');
    }
  });

  it('stops listening while recording', () => {
    expect(resolveShortcut(CTRL_L, 'recording')).toBe('stop-listening');
  });

  it('does nothing while the pipeline is busy or unconfigured', () => {
    const blocked: SessionState[] = [
      'unconfigured',
      'checking',
      'arming_capture',
      'encoding',
      'transcribing',
      'generating',
      'cancelling',
    ];
    for (const phase of blocked) {
      expect(resolveShortcut(CTRL_L, phase)).toBeNull();
    }
  });

  it('accepts Cmd+L the same as Ctrl+L', () => {
    expect(resolveShortcut(META_L, 'ready')).toBe('start-listening');
    expect(resolveShortcut(META_L, 'recording')).toBe('stop-listening');
  });

  it('ignores a plain l keystroke (typing in a field must never toggle)', () => {
    expect(resolveShortcut(key({ key: 'l' }), 'ready')).toBeNull();
  });

  it('ignores Ctrl+Shift+L and Alt combinations', () => {
    expect(resolveShortcut(key({ key: 'l', ctrlKey: true, shiftKey: true }), 'ready')).toBeNull();
    expect(resolveShortcut(key({ key: 'l', ctrlKey: true, altKey: true }), 'ready')).toBeNull();
  });
});

describe('resolveShortcut: Escape cancel', () => {
  it('cancels during every active phase', () => {
    const active: SessionState[] = [
      'arming_capture',
      'recording',
      'encoding',
      'transcribing',
      'generating',
    ];
    for (const phase of active) {
      expect(resolveShortcut(ESCAPE, phase)).toBe('cancel');
    }
  });

  it('does nothing when there is no session to cancel', () => {
    for (const phase of ['ready', 'complete', 'failed', 'cancelling'] as SessionState[]) {
      expect(resolveShortcut(ESCAPE, phase)).toBeNull();
    }
  });

  it('ignores Escape with modifiers held', () => {
    expect(resolveShortcut(key({ key: 'Escape', ctrlKey: true }), 'recording')).toBeNull();
    expect(resolveShortcut(key({ key: 'Escape', shiftKey: true }), 'recording')).toBeNull();
  });
});

describe('resolveShortcut: copy', () => {
  it('maps Ctrl+Shift+C to copy-answer', () => {
    expect(resolveShortcut(CTRL_SHIFT_C, 'complete')).toBe('copy-answer');
    expect(resolveShortcut(CTRL_SHIFT_C, 'ready')).toBe('copy-answer');
  });

  it('never intercepts plain Ctrl+C (text selection copy)', () => {
    expect(resolveShortcut(key({ key: 'c', ctrlKey: true }), 'complete')).toBeNull();
  });
});
