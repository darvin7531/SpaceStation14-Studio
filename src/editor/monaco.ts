/**
 * Monaco runs entirely from the packaged app. Do not load editor code or workers
 * from a CDN: the editor must work offline in a Tauri webview.
 */
import * as monaco from 'monaco-editor/editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/bracketMatching/register';

type MonacoSelf = typeof self & {
  MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker };
};

(self as MonacoSelf).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
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

// JSON metadata only needs fast syntax colouring while the viewer is read-only.
// Avoid the full Monaco JSON language service and its additional worker/bundle.
monaco.languages.register({ id: 'ss14-json' });
monaco.languages.setMonarchTokensProvider('ss14-json', {
  tokenizer: {
    root: [
      [/"(?:\\.|[^"\\])*"(?=\s*:)/, 'key'],
      [/"(?:\\.|[^"\\])*"/, 'string'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/[{}\[\],:]/, 'delimiter'],
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
  return 'ss14-json';
}

export { monaco };
