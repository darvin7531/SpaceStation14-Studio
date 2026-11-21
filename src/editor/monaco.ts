/**
 * Monaco runs entirely from the packaged app. Do not load editor code or workers
 * from a CDN: the editor must work offline in a Tauri webview.
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import 'monaco-editor/esm/vs/editor/editor.main.css';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';

type MonacoSelf = typeof self & {
  MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker };
};

(self as MonacoSelf).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

// Fluent syntax highlighting is intentionally a lightweight tokenizer, not
// semantic validation. Invalid FTL is never silently "corrected".
monaco.languages.register({ id: 'fluent', extensions: ['.ftl'] });
monaco.languages.setMonarchTokensProvider('fluent', {
  tokenizer: {
    root: [
      [/^\s*#[^\r\n]*/, 'comment'],
      [/^\s*-?[\w-]+(?=\s*=)/, 'key'],
      [/\$[\w-]+/, 'variable'],
      [/\{/, { token: 'delimiter.bracket', next: '@placeable' }],
      [/<\/?[\w-]+>/, 'tag'],
      [/"[^"]*"/, 'string'],
    ],
    placeable: [
      [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
      [/\$[\w-]+/, 'variable'],
      [/\b\d+(?:\.\d+)?\b/, 'number'],
      [/"[^"]*"/, 'string'],
      [/\w+/, 'identifier'],
    ],
  },
});

monaco.editor.defineTheme('ss14-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [{ token: 'key', foreground: '92B9FF' }],
  colors: {
    'editor.background': '#0b111a',
    'editor.foreground': '#d6e4f5',
    'editorLineNumber.foreground': '#55677e',
    'editorLineNumber.activeForeground': '#a6b7cc',
  },
});

export function resourceLanguage(kind: 'yaml' | 'ftl' | 'rsi'): string {
  if (kind === 'yaml') return 'yaml';
  if (kind === 'ftl') return 'fluent';
  return 'json';
}

export { monaco };
