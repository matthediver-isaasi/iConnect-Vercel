import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Team from '@/pages/Team.jsx';
import '@/index.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
window.refreshTeam = () => client.invalidateQueries({ queryKey: ['team-members'] });
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><Team /></QueryClientProvider>,
);
