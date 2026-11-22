import type { NewFluentDraft } from './api';

export function suggestedFluentDraft(preferredFile?: string, suggested?: NewFluentDraft): NewFluentDraft {
  const parent = preferredFile?.slice(0, preferredFile.lastIndexOf('/') + 1);
  const directory = parent?.startsWith('Resources/Locale/') ? parent : 'Resources/Locale/en-US/';
  return {
    file: suggested?.file ?? directory + 'StudioNew.ftl',
    starter_key: suggested?.starter_key ?? 'new-message',
    starter_value: suggested?.starter_value ?? 'New message',
    ...(suggested?.starter_description !== undefined
      ? { starter_description: suggested.starter_description } : {}),
    ...(suggested?.starter_suffix !== undefined
      ? { starter_suffix: suggested.starter_suffix } : {}),
  };
}
