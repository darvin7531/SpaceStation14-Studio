import { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { ResourceDocument, ResourceEntry } from '../lib/api';

interface Props {
  resource: ResourceEntry;
  document: ResourceDocument;
  revealLine?: number;
  jumpToken?: number;
}

/**
 * Lazy-loads Monaco only when a resource is opened, and disposes the model,
 * workers' consumers and editor on tab switch/unmount.
 */
export default function MonacoPreview({ resource, document, revealLine, jumpToken }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ revealLineInCenter(line: number): void; setPosition(position: { lineNumber: number; column: number }): void } | null>(null);
  const latestJump = useRef(revealLine);
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

        const model = monaco.editor.createModel(document.content, resourceLanguage(resource.kind));
        try {
          const editor = monaco.editor.create(containerRef.current, {
            model,
            theme: 'ss14-dark',
            readOnly: true,
            domReadOnly: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            tabSize: 2,
            scrollBeyondLastLine: false,
            smoothScrolling: false,
            renderWhitespace: 'selection',
            wordWrap: 'off',
            padding: { top: 14, bottom: 14 },
            overviewRulerBorder: false,
          });
          editorRef.current = editor;
          if (latestJump.current) {
            editor.revealLineInCenter(latestJump.current);
            editor.setPosition({ lineNumber: latestJump.current, column: 1 });
          }
          dispose = () => {
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
  }, [document.content, document.path, resource.kind]);

  if (failure) {
    return <div className="monaco-fallback" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>Не удалось загрузить редактор Monaco.</strong>
        <p>Текст ресурса доступен ниже. Перезапустите Studio, если проблема повторяется.</p>
        <details><summary>Техническая ошибка</summary><pre>{failure}</pre></details>
      </div>
      <pre className="fallback-content"><code>{document.content}</code></pre>
    </div>;
  }
  return <div className="monaco-shell">
    <div ref={containerRef} className="monaco-container" aria-label={'Только чтение: ' + document.path}/>
    {loading && <div className="monaco-loading" role="status">Загрузка редактора…</div>}
  </div>;
}
