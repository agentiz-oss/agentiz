import React, { useEffect, useState } from 'react';

const MODEL_ID = 'agentiz-assistant';

/** Fullscreen host for the exact Adminizer agent component. */
export default function MobileAssistant() {
  const [Agent, setAgent] = useState<React.ComponentType<any> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const routePrefix = (window as any).routePrefix ?? '/dashboard';
    void import(/* @vite-ignore */ `${routePrefix}/assets/ai-assistant/agent.es.js`)
      .then((module) => { if (alive) setAgent(() => module.default); })
      .catch((cause) => {
        console.error('Unable to load the Adminizer assistant UI', cause);
        if (alive) setError('Unable to load the assistant. Please try again.');
      });
    return () => { alive = false; };
  }, []);

  const routePrefix = (window as any).routePrefix ?? '/dashboard';
  return <main style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', background: 'var(--background, #fff)' }}>
    {error ? <p style={{ margin: 'auto' }}>{error}</p> : Agent ? <Agent routePrefix={routePrefix} modelId={MODEL_ID} layout="page" /> : <p style={{ margin: 'auto' }}>Loading assistant…</p>}
  </main>;
}
