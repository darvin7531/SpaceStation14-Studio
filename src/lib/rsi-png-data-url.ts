import { uiText, type Language } from './ui-language';

export function readPngAsDataUrl(file: File, language?: Language): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(language ? uiText(language, 'rsi.bulk.read', { name: file.name }) : 'Невозможно прочитать PNG ' + file.name));
    };
    reader.onerror = () => reject(reader.error ?? new Error(language ? uiText(language, 'rsi.bulk.readFailed', { name: file.name }) : 'Не удалось прочитать ' + file.name));
    // Normalize the Data URL MIME type; native code validates the actual PNG bytes.
    reader.readAsDataURL(new Blob([file], { type: 'image/png' }));
  });
}
