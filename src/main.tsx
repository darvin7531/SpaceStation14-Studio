import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import './styles.css';
import './styles.prototypes.css';
import './styles.recovery.css';
import './styles.diff.css';
import './styles.create-prototype.css';
import './styles.fields.css';
import './styles.components.css';
import './styles.rsi.css';
import './styles.fluent.css';
import './styles.fluent-diagnostics.css';
import './styles.csharp.css';
import './styles.settings.css';
import './styles.search.css';

const root = document.getElementById('root');
if (!root) throw new Error('The Studio root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode><I18nProvider><App /></I18nProvider></React.StrictMode>,
);
