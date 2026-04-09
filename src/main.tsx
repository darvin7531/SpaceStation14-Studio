import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { I18nProvider } from './i18n.tsx';
import { EditorSettingsProvider } from './editorSettings.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <EditorSettingsProvider>
        <App />
      </EditorSettingsProvider>
    </I18nProvider>
  </StrictMode>,
);
