import React, { useEffect, useState } from 'react';
import {
  PREFERENCES_SECTIONS,
  type PreferencesSection,
  type PublicSettings,
} from '../shared/domain';
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

/** `#/preferences/<section>` selects a tab; anything else falls back to the default. */
function preferencesSection(route: string): PreferencesSection | undefined {
  const candidate = route.split('/')[2];
  return PREFERENCES_SECTIONS.find((s) => s === candidate);
}

export function App(): React.JSX.Element {
  const route = useHashRoute();
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const apply = (s: PublicSettings) => {
    setSettings(s);
    setLoadError(null);
    document.documentElement.style.setProperty('--font-scale', String(s.fontScale));
  };

  const refresh = async () => {
    try {
      apply(await window.cuedeck.getPublicSettings());
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err ? err.message : undefined;
      setLoadError(typeof message === 'string' ? message : 'The request failed.');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    // Writes made in the other window (Preferences ↔ coach) arrive here, so
    // neither window shows stale providers, keys, or layout settings.
    return window.cuedeck.onSettingsChanged(apply);
  }, []);

  if (!settings) {
    return (
      <div className="onboarding">
        {loadError ? (
          <>
            <p className="error-banner" role="alert" data-testid="settings-load-error">
              Settings could not be loaded: {loadError}
            </p>
            <button onClick={() => void refresh()}>Retry</button>
          </>
        ) : (
          'Loading…'
        )}
      </div>
    );
  }

  if (route.startsWith('/preferences')) {
    return (
      <Preferences
        settings={settings}
        onSettingsChanged={refresh}
        section={preferencesSection(route)}
      />
    );
  }

  if (!settings.onboardingComplete) {
    return <Onboarding settings={settings} onSettingsChanged={refresh} />;
  }

  return <Coach settings={settings} onSettingsChanged={refresh} />;
}
