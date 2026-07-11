import React, { useEffect, useState } from 'react';
import type { PublicSettings } from '../shared/domain';
import { Coach } from './routes/Coach';
import { Onboarding } from './routes/Onboarding';
import { Preferences } from './routes/Preferences';

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.replace(/^#/, '') || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App(): React.JSX.Element {
  const route = useHashRoute();
  const [settings, setSettings] = useState<PublicSettings | null>(null);

  const refresh = async () => {
    const s = await window.cuedeck.getPublicSettings();
    setSettings(s);
    document.documentElement.style.setProperty('--font-scale', String(s.fontScale));
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!settings) {
    return <div className="onboarding">Loading…</div>;
  }

  if (route.startsWith('/preferences')) {
    return <Preferences settings={settings} onSettingsChanged={refresh} />;
  }

  if (!settings.onboardingComplete) {
    return <Onboarding settings={settings} onSettingsChanged={refresh} />;
  }

  return <Coach settings={settings} onSettingsChanged={refresh} />;
}
