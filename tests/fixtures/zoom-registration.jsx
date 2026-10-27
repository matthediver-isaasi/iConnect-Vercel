import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../client/src/index.css';
import ChangeZoomDialog from '../../client/src/components/events/ChangeZoomDialog';
function App() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('Unsaved title');
  const session = location.search.includes('session');
  return <><input aria-label="Event title" value={title} onChange={e => setTitle(e.target.value)} />
    <button onClick={() => setOpen(true)}>Manage Zoom</button>
    <ChangeZoomDialog open={open} onOpenChange={setOpen} endpointBase={session ? '/api/complex-event-sessions/session' : '/api/events/event'}
      mode={session ? 'change' : 'reconcile'} initialType="meeting" currentTarget={{zoom_meeting_id:'local'}} onSuccess={() => {}} />
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
