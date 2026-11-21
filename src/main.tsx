import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './styles.prototypes.css';
import './styles.recovery.css';
import './styles.diff.css';
import './styles.create-prototype.css';
import './styles.fields.css';
import './styles.components.css';
import './styles.rsi.css';

const root = document.getElementById('root');
if (!root) throw new Error('The Studio root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode><App /></React.StrictMode>,
);
