import React from 'react';
import { createRoot } from 'react-dom/client';
import './bloom.css';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';

async function mount() {
  const { installTauriBridge } = await import('./tauri-bridge');
  const showWindow = await installTauriBridge();
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
  requestAnimationFrame(() => requestAnimationFrame(() => void showWindow().catch(console.error)));
}

void mount().catch(error => {
  console.error(error);
  document.getElementById('root')!.textContent = 'MYMIND could not open the planner. Close and reopen the app.';
});
