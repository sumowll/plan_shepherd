import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initPrivacy } from './privacy';

function SessionApp() {
  useEffect(() => initPrivacy(), []);
  return <App />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is unavailable.');
createRoot(root).render(<StrictMode><SessionApp /></StrictMode>);
