import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsWindow } from './records/RecordsWindow.tsx';
import './styles/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(<StrictMode><RecordsWindow api={window.picpatchRecords} /></StrictMode>);
