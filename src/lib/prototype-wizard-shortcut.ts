export function prototypeWizardShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'>,
  busy: boolean,
): 'close' | 'submit' | null {
  if (busy || event.repeat || event.isComposing || event.altKey) return null;
  if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.shiftKey) return 'close';
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) return 'submit';
  return null;
}
