import { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { studio, type ResourceDocument, type ResourceEntry } from '../lib/api';
import { yamlCompletionContext } from './yaml-completion';
import type { EditorSettings } from '../lib/editor-settings';
import { identifierAtColumn } from '../lib/editor-navigation';

interface Props {
  settings: EditorSettings;
  resource: ResourceEntry;
  document: ResourceDocument;
  revealLine?: number;
  jumpToken?: number;
  value: string;
  editable: boolean;
  onChange?: (value: string) => void;
  onNavigateIdentifier?: (identifier: string) => void;
}

/**
 * Lazy-loads Monaco only when a resource is opened, and disposes the model,
 * workers' consumers and editor on tab switch/unmount.
 */
export default function MonacoPreview({ resource, document, revealLine, jumpToken, value, editable, onChange, onNavigateIdentifier, settings }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ revealLineInCenter(line: number): void; setPosition(position: { lineNumber: number; column: number }): void } | null>(null);
  const latestJump = useRef(revealLine);
  const contentRef = useRef<{ getValue(): string; setValue(value: string): void } | null>(null);
  const updateOptionsRef = useRef<{ updateOptions(value: {
    readOnly?: boolean; domReadOnly?: boolean; fontSize?: number; tabSize?: number;
    wordWrap?: 'on' | 'off'; lineNumbers?: 'on' | 'off' | 'relative';
    minimap?: { enabled: boolean };
  }): void } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onNavigateRef = useRef(onNavigateIdentifier);
  onNavigateRef.current = onNavigateIdentifier;

  // A new disk revision or a discarded draft updates Monaco without losing
  // text typed before a React rerender. Ordinary keystrokes do not reset undo.
  useEffect(() => {
    if (contentRef.current && contentRef.current.getValue() !== value) {
      contentRef.current.setValue(value);
    }
  }, [value]);

  useEffect(() => {
    updateOptionsRef.current?.updateOptions({
      readOnly: !editable,
      domReadOnly: !editable,
    });
  }, [editable]);
  useEffect(() => {
    updateOptionsRef.current?.updateOptions({
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap,
      lineNumbers: settings.lineNumbers,
      minimap: { enabled: settings.minimap },
    });
  }, [settings]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    latestJump.current = revealLine;
    if (revealLine && editorRef.current) {
      editorRef.current.revealLineInCenter(revealLine);
      editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
    }
  }, [revealLine, jumpToken]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setFailure(null);
    setLoading(true);

    async function mount() {
      try {
        const { monaco, resourceLanguage } = await import('./monaco');
        if (cancelled || !containerRef.current) return;

        const model = monaco.editor.createModel(value, resourceLanguage(resource.kind));
        try {
          const editor = monaco.editor.create(containerRef.current, {
            model,
            theme: 'ss14-dark',
            readOnly: !editable,
            domReadOnly: !editable,
            automaticLayout: true,
            minimap: { enabled: settingsRef.current.minimap },
            fontSize: settingsRef.current.fontSize,
            tabSize: settingsRef.current.tabSize,
            lineNumbers: settingsRef.current.lineNumbers,
            scrollBeyondLastLine: false,
            smoothScrolling: false,
            renderWhitespace: 'selection',
            wordWrap: settingsRef.current.wordWrap,
            padding: { top: 14, bottom: 14 },
            overviewRulerBorder: false,
          });
          editorRef.current = editor;
          contentRef.current = model;
          updateOptionsRef.current = editor;
          const subscription = editor.onDidChangeModelContent(() => {
            onChangeRef.current?.(editor.getValue());
          });
          // Restore Electron's indexed parent/component completions. Provider
          // belongs to the current Monaco model and is disposed with the tab.
          const completions = resource.kind === 'yaml'
            ? monaco.languages.registerCompletionItemProvider('yaml', {
              triggerCharacters: [' ', ':', '-', ',', '['],
              provideCompletionItems: async (source, position, _context, token) => {
                if (source !== model || token.isCancellationRequested) return { suggestions: [] };
                const first = Math.max(1, position.lineNumber - 64);
                const lines = Array.from({ length: position.lineNumber - first + 1 },
                  (_, offset) => source.getLineContent(first + offset));
                const target = yamlCompletionContext(lines, lines.length, position.column);
                if (!target) return { suggestions: [] };
                try {
                  const entries = target.kind === 'prototype-parent'
                    ? (await studio.searchPrototypes(target.query, '', 0, 80)).items
                        .map((item) => ({ label: item.id, detail: item.kind + ' · ' + item.file }))
                    : (await studio.searchCSharpDefinitions(target.query, 'component', 0, 80)).items
                        .map((item) => ({ label: item.name, detail: item.class_name + ' · ' + item.file }));
                  if (token.isCancellationRequested || cancelled) return { suggestions: [] };
                  const seen = new Set<string>();
                  const candidates = entries.flatMap((item) => {
                    if (!item.label.toLowerCase().startsWith(target.query.toLowerCase())) return [];
                    if (seen.has(item.label)) return [];
                    seen.add(item.label);
                    return [{
                      label: item.label,
                      kind: target.kind === 'component-type'
                        ? monaco.languages.CompletionItemKind.Class
                        : monaco.languages.CompletionItemKind.Reference,
                      insertText: item.label,
                      detail: item.detail,
                      range: {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: target.startColumn,
                        endColumn: position.column,
                      },
                    }];
                  });
                  return { suggestions: candidates };
                } catch {
                  // A malformed/stale index must not make editing YAML impossible.
                  return { suggestions: [] };
                }
              },
            }) : null;
          const navigateSubscription = editor.onMouseDown((event) => {
            if (!settingsRef.current.ctrlClickNavigation || !onNavigateRef.current) return;
            if (!(event.event.ctrlKey || event.event.metaKey) || !event.event.leftButton) return;
            const position = event.target.position;
            if (!position) return;
            const identifier = identifierAtColumn(
              model.getLineContent(position.lineNumber), position.column,
            );
            if (identifier) onNavigateRef.current(identifier);
          });
          if (latestJump.current) {
            editor.revealLineInCenter(latestJump.current);
            editor.setPosition({ lineNumber: latestJump.current, column: 1 });
          }
          dispose = () => {
            subscription.dispose();
            navigateSubscription.dispose();
            completions?.dispose();
            contentRef.current = null;
            updateOptionsRef.current = null;
            editorRef.current = null;
            editor.dispose();
            model.dispose();
          };
          if (!cancelled) setLoading(false);
        } catch (error) {
          model.dispose();
          throw error;
        }
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
          setLoading(false);
        }
      }
    }

    void mount();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [document.path, resource.kind]);

  if (failure) {
    return <div className="monaco-fallback" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>Не удалось загрузить редактор Monaco.</strong>
        <p>Предпросмотр содержимого доступен ниже. Редактирование через Monaco недоступно, если компонент не загрузился.</p>
        <details><summary>Техническая ошибка</summary><pre>{failure}</pre></details>
      </div>
      <pre className="fallback-content"><code>{document.content}</code></pre>
    </div>;
  }
  return <div className="monaco-shell">
    <div ref={containerRef} className="monaco-container" aria-label={(editable ? 'Редактирование: ' : 'Только чтение: ') + document.path}/>
    {loading && <div className="monaco-loading" role="status">Загрузка редактора…</div>}
  </div>;
}
