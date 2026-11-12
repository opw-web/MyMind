import React from 'react';
import { createRoot } from 'react-dom/client';
import './bloom.css';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';

async function mount() {
  let showWindow: (() => Promise<void>) | undefined;
  if (!window.planner && '__TAURI_INTERNALS__' in window) {
    const { installTauriBridge } = await import('./tauri-bridge');
    showWindow = await installTauriBridge();
  }
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
  if (showWindow) requestAnimationFrame(() => requestAnimationFrame(() => void showWindow().catch(console.error)));
}

void mount().catch(error => {
  console.error(error);
  document.getElementById('root')!.textContent = 'MYMIND could not open the planner. Close and reopen the app.';
});
