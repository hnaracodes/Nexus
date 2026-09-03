import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from './router.js';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
