import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { api } from './api.ts';
import { reportRendererErrors } from './errors.ts';
import './styles/tokens.css';
import './styles/app.css';

reportRendererErrors(api.reportError);
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
