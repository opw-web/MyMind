import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './bloom.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
