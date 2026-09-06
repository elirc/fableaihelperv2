import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RECOMMENDED_OLLAMA_MODELS } from '../../shared/catalog';
import type {
  DiagnosticsReport,
  HistoryItem,
  ModelSummary,
  PreferencesSection as Section,
  Profile,
  ProviderMeta,
  ProviderProbe,
  PublicSettings,
} from '../../shared/domain';
import { filterHistory } from '../../shared/historySearch';

interface Props {
  settings: PublicSettings;
  onSettingsChanged: () => Promise<void>;
}

export function Preferences({
  settings,
  onSettingsChanged,
  section: requested,
}: Props & { section?: Section }): React.JSX.Element {
  const [section, setSection] = useState<Section>(requested ?? 'general');
  useEffect(() => {
    // The coach can re-point an already open window (error banner → providers).
    if (requested) setSection(requested);
  }, [requested]);
  const sections: Array<[Section, string]> = [
    ['general', 'General'],
    ['providers', 'Providers'],
    ['profiles', 'Profiles'],
    ['history', 'History'],
    ['diagnostics', 'Diagnostics'],
    ['about', 'Privacy & consent'],
  ];

  return (
    <div className="app-shell">
      <header className="titlebar">
        <span className="brand">CueDeck Preferences</span>
      </header>
      <div className="prefs-shell">
        <nav className="prefs-nav" aria-label="preference sections">
          {sections.map(([id, label]) => (
            <button
              key={id}
              aria-current={section === id}
              onClick={() => setSection(id)}
              data-testid={`nav-${id}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="prefs-content">
          {section === 'general' && (
            <GeneralSection settings={settings} onSettingsChanged={onSettingsChanged} />
          )}
          {section === 'providers' && (
            <ProvidersSection settings={settings} onSettingsChanged={onSettingsChanged} />
          )}
          {section === 'profiles' && (
            <ProfilesSection settings={settings} onSettingsChanged={onSettingsChanged} />
          )}
          {section === 'history' && (
            <HistorySection settings={settings} onSettingsChanged={onSettingsChanged} />
          )}
          {section === 'diagnostics' && <DiagnosticsSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

function GeneralSection({ settings, onSettingsChanged }: Props): React.JSX.Element {
  const update = async (patch: Partial<PublicSettings>) => {
    await window.cuedeck.updatePublicSettings(patch);
    await onSettingsChanged();
  };
  return (
    <>
      <h1>General</h1>
      <label className="row">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={settings.alwaysOnTop}
          onChange={(e) => void update({ alwaysOnTop: e.target.checked })}
        />
        <span>Keep the coach window on top of other windows</span>
      </label>
      <label className="row">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={settings.compactMode}
          onChange={(e) => void update({ compactMode: e.target.checked })}
        />
        <span>Compact coach layout (recording indicator always stays visible)</span>
      </label>
      <label className="row" style={{ alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          style={{ width: 'auto', marginTop: 4 }}
          checked={settings.conversationMemory}
          onChange={(e) => void update({ conversationMemory: e.target.checked })}
          data-testid="conversation-memory-toggle"
        />
        <span>
          Remember the last two exchanges and send them with each request, so follow-up questions
          are answered in context. Costs a few hundred extra tokens per response; “Clear” in the
          coach window forgets them.
        </span>
      </label>
      <label className="field">
        <span>Text size ({Math.round(settings.fontScale * 100)}%)</span>
        <input
          type="range"
          min={0.9}
          max={1.6}
          step={0.05}
          value={settings.fontScale}
          onChange={(e) => void update({ fontScale: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span>Maximum clip length: {settings.maxClipSeconds} seconds</span>
        <input
          type="range"
          min={30}
          max={120}
          step={5}
          value={settings.maxClipSeconds}
          onChange={(e) => void update({ maxClipSeconds: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span>Target speaking time</span>
        <select
          value={settings.targetSeconds}
          onChange={(e) =>
            void update({
              targetSeconds: Number(e.target.value) as PublicSettings['targetSeconds'],
            })
          }
        >
          <option value={15}>15 seconds</option>
          <option value={30}>30 seconds</option>
          <option value={60}>60 seconds</option>
          <option value={90}>90 seconds (technical explanations)</option>
          <option value={120}>2 minutes (system design)</option>
        </select>
      </label>
      <label className="field">
        <span>Transcription language</span>
        <select
          value={settings.sttLanguage}
          onChange={(e) => void update({ sttLanguage: e.target.value })}
        >
          <option value="auto">Detect automatically</option>
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="zh">Chinese</option>
          <option value="tl">Tagalog</option>
        </select>
      </label>
    </>
  );
}

function ProvidersSection({ settings, onSettingsChanged }: Props): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [probes, setProbes] = useState<Record<string, ProviderProbe>>({});
  const [models, setModels] = useState<Record<string, ModelSummary[]>>({});
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaBaseUrl);
  const [ollamaConfirm, setOllamaConfirm] = useState(false);
  /** Provider whose model was already auto-picked, so a manual "" sticks. */
  const autoPicked = useRef('');

  useEffect(() => {
    void window.cuedeck.listProviders().then(setProviders);
  }, []);

  const update = async (patch: Partial<PublicSettings>) => {
    await window.cuedeck.updatePublicSettings(patch);
    await onSettingsChanged();
  };

  const probe = async (providerId: string) => {
    const result = await window.cuedeck
      .probeProvider(providerId)
      .catch((err: { message?: string }): ProviderProbe => ({
        providerId,
        status: 'unknown-failure',
        detail: err?.message,
      }));
    setProbes((p) => ({ ...p, [providerId]: result }));
    if (result.models) setModels((m) => ({ ...m, [providerId]: result.models as ModelSummary[] }));
    return result;
  };

  // Stable identities: LocalModelPicker lists its loader as an effect
  // dependency, so a fresh arrow per render would refetch on every render.
  const loadModels = useCallback(async (providerId: string) => {
    const list = await window.cuedeck.listModels(providerId).catch(() => []);
    setModels((m) => ({ ...m, [providerId]: list }));
  }, []);
  const loadLocalModels = useCallback(() => void loadModels('local-whisper'), [loadModels]);

  const sttProviders = providers.filter((p) => p.kind === 'stt');
  const llmProviders = providers.filter((p) => p.kind === 'llm');
  // One key section per cloud account, derived from provider metadata so a
  // newly registered provider shows up without touching this component.
  const cloudProviders = [
    ...new Set(providers.filter((p) => p.location === 'cloud').map((p) => p.credentialId ?? p.id)),
  ];
  const ollamaIsRemote = !/^https?:\/\/(localhost|127\.|\[::1\])/.test(ollamaUrl);
  const llmModels = models[settings.llmProviderId] ?? [];
  const llmNeedsModel = settings.llmProviderId === 'ollama' && settings.llmModelId === '';

  useEffect(() => {
    autoPicked.current = '';
  }, [settings.llmProviderId]);

  useEffect(() => {
    // Same rule as the coordinator (and onboarding): Ollama with no model
    // chosen cannot answer anything, so take the first recommended model
    // that is installed as soon as the list arrives.
    if (!llmNeedsModel || llmModels.length === 0) return;
    if (autoPicked.current === settings.llmProviderId) return;
    autoPicked.current = settings.llmProviderId;
    const pick =
      RECOMMENDED_OLLAMA_MODELS.find((id) => llmModels.some((m) => m.id === id)) ?? llmModels[0].id;
    void update({ llmModelId: pick });
  }, [llmModels, llmNeedsModel, settings.llmProviderId]);

  const providerStatus = (id: string) => {
    const p = probes[id];
    if (!p) return null;
    return (
      <span role="status">
        {p.status === 'ready' ? '✓ ready' : `✗ ${p.status}`}
        {p.detail ? ` — ${p.detail}` : ''}
        {p.latencyMs !== undefined ? ` (${p.latencyMs} ms)` : ''}
      </span>
    );
  };

  return (
    <>
      <h1>Providers</h1>
      <section className="card">
        <h2>Processing summary</h2>
        <p>
          Speech-to-text: <strong>{settings.sttProviderId}</strong> (
          {sttProviders.find((p) => p.id === settings.sttProviderId)?.location ?? '?'}) • Responses:{' '}
          <strong>{settings.llmProviderId}</strong> (
          {llmProviders.find((p) => p.id === settings.llmProviderId)?.location ?? '?'})
        </p>
        <p>
          When a cloud provider is selected, speech-to-text receives the current audio clip.
          Responses use your transcript, personal instructions, active profile, and session notes.
          Expansions also send the answer being expanded; conversation memory adds the last two
          exchanges when enabled.
        </p>
        <button
          className="small"
          onClick={() => void update({ sttProviderId: 'local-whisper', llmProviderId: 'ollama' })}
        >
          Switch everything to local-only
        </button>
      </section>

      <section className="card">
        <h2>Speech-to-text</h2>
        <label className="field">
          <span>Provider</span>
          <select
            value={settings.sttProviderId}
            onChange={(e) => void update({ sttProviderId: e.target.value })}
          >
            {sttProviders.map((p) => (
              <option
                key={p.id}
                value={p.id}
                disabled={
                  p.location === 'cloud' &&
                  !settings.credentials[p.credentialId ?? p.id]?.configured
                }
              >
                {p.displayName}
                {p.freePolicy === 'always-free-local'
                  ? ' — always free'
                  : ' — free tier, limits may change'}
              </option>
            ))}
          </select>
        </label>
        {settings.sttProviderId === 'local-whisper' && (
          <LocalModelPicker
            settings={settings}
            models={models['local-whisper']}
            onLoad={loadLocalModels}
            onSettingsChanged={onSettingsChanged}
          />
        )}
        <div className="row">
          <button className="small" onClick={() => void probe(settings.sttProviderId)}>
            Test speech-to-text
          </button>
          {providerStatus(settings.sttProviderId)}
        </div>
      </section>

      <section className="card">
        <h2>Response model</h2>
        <label className="field">
          <span>Provider</span>
          <select
            value={settings.llmProviderId}
            onChange={(e) => void update({ llmProviderId: e.target.value, llmModelId: '' })}
          >
            {llmProviders.map((p) => (
              <option
                key={p.id}
                value={p.id}
                disabled={
                  p.location === 'cloud' &&
                  !settings.credentials[p.credentialId ?? p.id]?.configured
                }
              >
                {p.displayName}
                {p.freePolicy === 'always-free-local'
                  ? ' — always free'
                  : ' — free tier, limits may change'}
              </option>
            ))}
          </select>
        </label>
        {llmNeedsModel && (
          <p className="warn-banner" role="status" data-testid="llm-no-model">
            No model selected — click Check &amp; list models and choose one.
          </p>
        )}
        <div className="row">
          <button
            className="small"
            onClick={() =>
              void probe(settings.llmProviderId).then(() => loadModels(settings.llmProviderId))
            }
          >
            Check &amp; list models
          </button>
          {providerStatus(settings.llmProviderId)}
        </div>
        {llmModels.length > 0 && (
          <label className="field">
            <span>Model</span>
            <select
              value={settings.llmModelId}
              onChange={(e) => void update({ llmModelId: e.target.value })}
            >
              <option value="">Choose a model…</option>
              {llmModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        <details open={settings.llmBackupProviderId !== ''}>
          <summary>Backup response model (used only if the primary fails)</summary>
          <p className="hint">
            Free tiers rate-limit and occasionally go down mid-interview. If the primary model fails
            before it produces anything (rate limit, outage, timeout, rejected key), the answer is
            retried once on this backup and the status rail says so. Nothing is ever switched
            silently; the backup must have its own key and disclosure accepted below.
          </p>
          <label className="field">
            <span>Backup provider</span>
            <select
              value={settings.llmBackupProviderId}
              onChange={(e) =>
                void update({ llmBackupProviderId: e.target.value, llmBackupModelId: '' })
              }
              data-testid="backup-provider"
            >
              <option value="">None</option>
              {llmProviders
                .filter((p) => p.id !== settings.llmProviderId)
                .map((p) => (
                  <option
                    key={p.id}
                    value={p.id}
                    disabled={
                      p.location === 'cloud' &&
                      !settings.credentials[p.credentialId ?? p.id]?.configured
                    }
                  >
                    {p.displayName}
                  </option>
                ))}
            </select>
          </label>
          {settings.llmBackupProviderId !== '' && (
            <>
              <div className="row">
                <button
                  className="small"
                  onClick={() =>
                    void probe(settings.llmBackupProviderId).then(() =>
                      loadModels(settings.llmBackupProviderId),
                    )
                  }
                >
                  Check &amp; list models
                </button>
                {providerStatus(settings.llmBackupProviderId)}
              </div>
              {(models[settings.llmBackupProviderId] ?? []).length > 0 && (
                <label className="field">
                  <span>Backup model</span>
                  <select
                    value={settings.llmBackupModelId}
                    onChange={(e) => void update({ llmBackupModelId: e.target.value })}
                    data-testid="backup-model"
                  >
                    <option value="">Choose a model…</option>
                    {(models[settings.llmBackupProviderId] ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {settings.llmBackupModelId === '' && (
                <p className="hint">Pick a backup model, or the backup stays inactive.</p>
              )}
            </>
          )}
        </details>
        {settings.llmProviderId === 'openrouter' && (
          <label className="row" style={{ alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              style={{ width: 'auto', marginTop: 4 }}
              checked={settings.allowPaidModels}
              onChange={(e) =>
                void update({ allowPaidModels: e.target.checked }).then(() =>
                  loadModels('openrouter'),
                )
              }
              data-testid="allow-paid-toggle"
            />
            <span>
              Allow paid OpenRouter models. Usage is billed to your own OpenRouter credits — set a
              spending limit on the key at{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void window.cuedeck.openExternal('https://openrouter.ai/keys');
                }}
              >
                openrouter.ai/keys
              </a>{' '}
              before enabling. Prices per million tokens are shown in the model list, cheapest
              first.
            </span>
          </label>
        )}
        {settings.llmProviderId === 'ollama' && (
          <details>
            <summary>Advanced: Ollama server address</summary>
            <label className="field">
              <span>Base URL (default http://127.0.0.1:11434)</span>
              <input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} />
            </label>
            {ollamaIsRemote && (
              <label className="row warn-banner">
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={ollamaConfirm}
                  onChange={(e) => setOllamaConfirm(e.target.checked)}
                />
                <span>
                  This is not a local address. Prompts, transcripts, and profile data will leave
                  this device. Only private-network addresses (10.x, 172.16–31.x, 192.168.x, or a
                  .local name) are accepted; public hosts are refused. I understand.
                </span>
              </label>
            )}
            <button
              className="small"
              disabled={ollamaIsRemote && !ollamaConfirm}
              onClick={() => void update({ ollamaBaseUrl: ollamaUrl })}
            >
              Save server address
            </button>
          </details>
        )}
      </section>

      <section className="card">
        <h2>Cloud API keys (optional)</h2>
        <p>
          Keys are encrypted with Windows account protection, never shown again after saving, and
          removable at any time. Local mode needs no key.
        </p>
        {cloudProviders.map((id) => {
          const meta =
            providers.find((p) => p.id === id) ??
            providers.find((p) => (p.credentialId ?? p.id) === id);
          const configured = settings.credentials[id]?.configured ?? false;
          return (
            <div
              key={id}
              className="field"
              style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}
            >
              <span>
                <strong>{meta?.displayName ?? id}</strong> —{' '}
                {configured ? 'key saved' : 'no key saved'}
                {meta?.dataUseUrl && (
                  <>
                    {' '}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        void window.cuedeck.openExternal(meta.dataUseUrl as string);
                      }}
                    >
                      data-use policy
                    </a>
                  </>
                )}
              </span>
              {meta?.disclosure && (
                <span style={{ color: 'var(--warning)' }}>{meta.disclosure}</span>
              )}
              <div className="row">
                <input
                  type="password"
                  placeholder={configured ? 'Enter a new key to replace' : 'Paste API key'}
                  autoComplete="off"
                  value={keyInputs[id] ?? ''}
                  onChange={(e) => setKeyInputs((k) => ({ ...k, [id]: e.target.value }))}
                  style={{ maxWidth: 320 }}
                />
                <button
                  className="small"
                  disabled={!(keyInputs[id] ?? '').trim()}
                  onClick={async () => {
                    await window.cuedeck.setSecret(id, (keyInputs[id] ?? '').trim());
                    setKeyInputs((k) => ({ ...k, [id]: '' }));
                    await onSettingsChanged();
                    void probe(id);
                  }}
                >
                  {configured ? 'Replace' : 'Save'}
                </button>
                {configured && (
                  <button
                    className="small danger"
                    onClick={async () => {
                      await window.cuedeck.removeSecret(id);
                      await onSettingsChanged();
                    }}
                  >
                    Remove
                  </button>
                )}
                <button className="small" onClick={() => void probe(id)} disabled={!configured}>
                  Test
                </button>
                {providerStatus(id)}
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}

function LocalModelPicker({
  settings,
  models,
  onLoad,
  onSettingsChanged,
}: {
  settings: PublicSettings;
  models: ModelSummary[] | undefined;
  onLoad: () => void;
  onSettingsChanged: () => Promise<void>;
}): React.JSX.Element {
  const [download, setDownload] = useState<{ operationId: string; value?: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!models) onLoad();
  }, [models, onLoad]);

  useEffect(() => {
    return window.cuedeck.onOperationEvent((event) => {
      setDownload((current) => {
        if (!current || event.operationId !== current.operationId) return current;
        if (event.type === 'progress') return { ...current, value: event.value };
        if (event.type === 'complete') {
          setMessage('Model ready.');
          onLoad();
          return null;
        }
        setMessage(event.type === 'error' ? event.error.message : null);
        return null;
      });
    });
  }, [onLoad]);

  return (
    <>
      <label className="field">
        <span>Local model (downloaded on demand; stored in app data)</span>
        <select
          value={settings.sttModelId}
          onChange={async (e) => {
            await window.cuedeck.updatePublicSettings({ sttModelId: e.target.value });
            await onSettingsChanged();
          }}
        >
          {(models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.installed ? ' — installed' : ''}
            </option>
          ))}
        </select>
      </label>
      {download ? (
        <div className="row">
          <div className="progress-bar" style={{ flex: 1 }}>
            <div style={{ width: `${download.value ?? 5}%` }} />
          </div>
          <button
            className="small"
            onClick={() => void window.cuedeck.cancelDownload(download.operationId)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="small"
          onClick={async () => {
            setMessage(null);
            const { operationId } = await window.cuedeck.downloadModel(settings.sttModelId);
            setDownload({ operationId });
          }}
        >
          Download / verify selected model
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}

function ProfilesSection({ settings, onSettingsChanged }: Props): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [editing, setEditing] = useState<Partial<Profile> | null>(null);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setSystemPrompt(settings.systemPrompt), [settings.systemPrompt]);

  const save = async (operation: () => Promise<void>, confirmation: string) => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      await operation();
      await onSettingsChanged();
      setMessage(confirmation);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => setProfiles(await window.cuedeck.listProfiles());
  useEffect(() => {
    void refresh();
  }, []);

  const contextSize =
    (editing?.summary?.length ?? 0) +
    (editing?.roleContext?.length ?? 0) +
    (editing?.emphasisNotes?.length ?? 0);

  return (
    <>
      <h1>Profiles</h1>
      <p>Tailor answers to your background and the way you want to communicate.</p>
      <section className="card personalization-card">
        <h2>Personal instructions / system prompt</h2>
        <p className="hint" id="system-prompt-help">
          Set your preferred tone, audience, focus, and level of detail. Applies to every profile.
          Keep factual experience in a background profile below.
        </p>
        <label className="field">
          <span>Your instructions</span>
          <textarea
            rows={5}
            maxLength={8000}
            value={systemPrompt}
            disabled={saving}
            aria-describedby="system-prompt-help system-prompt-count"
            placeholder="Use plain language. Tailor explanations to a senior backend engineering interview. Start with the direct answer, then add details only when I ask."
            onChange={(e) => {
              setSystemPrompt(e.target.value);
              setMessage('');
            }}
            data-testid="system-prompt-input"
          />
        </label>
        <div className="row">
          <button
            className="primary"
            disabled={saving || systemPrompt === settings.systemPrompt}
            onClick={() =>
              void save(async () => {
                await window.cuedeck.updatePublicSettings({ systemPrompt });
              }, 'Personal instructions saved. They apply to your next response.')
            }
            data-testid="save-system-prompt"
          >
            Save instructions
          </button>
          <span className="hint" id="system-prompt-count">
            {systemPrompt.length.toLocaleString()} / 8,000 characters
            {systemPrompt !== settings.systemPrompt ? ' · Unsaved changes' : ''}
          </span>
        </div>
        <p className="hint">
          Leave blank to use the default guidance. Answers start concise; use Go deeper, Show an
          example, or Likely follow-ups under a response to expand it.
        </p>
      </section>
      {message && (
        <p role="status" data-testid="personalization-saved">
          {message}
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <h2>Background profiles</h2>
      <p className="hint">
        Add real experience, skills, and role context for targeted answers. Instructions and the
        active profile are saved on this computer and sent to your selected response provider.
      </p>
      {profiles.length === 0 && !editing && (
        <p data-testid="profiles-empty">
          Create a profile to ground answers in your own experience.
        </p>
      )}
      {profiles.map((p) => (
        <div
          key={p.id}
          className="card row"
          data-testid="profile-card"
          style={{ justifyContent: 'space-between', marginBottom: 8 }}
        >
          <span>
            <strong>{p.name}</strong>
            {settings.activeProfileId === p.id ? ' — active' : ''}
          </span>
          <span className="row">
            {settings.activeProfileId !== p.id && (
              <button
                className="small"
                disabled={saving}
                onClick={() =>
                  void save(async () => {
                    await window.cuedeck.updatePublicSettings({ activeProfileId: p.id });
                  }, `${p.name} is now your active profile.`)
                }
              >
                Make active
              </button>
            )}
            <button className="small" disabled={saving} onClick={() => setEditing(p)}>
              Edit
            </button>
            <button
              className="small danger"
              disabled={saving}
              onClick={() =>
                void save(async () => {
                  await window.cuedeck.deleteProfile(p.id);
                  if (settings.activeProfileId === p.id) {
                    await window.cuedeck.updatePublicSettings({ activeProfileId: '' });
                  }
                  if (editing?.id === p.id) setEditing(null);
                  await refresh();
                }, 'Profile deleted.')
              }
            >
              Delete
            </button>
          </span>
        </div>
      ))}
      {editing ? (
        <div className="card">
          <label className="field">
            <span>Name</span>
            <input
              value={editing.name ?? ''}
              maxLength={120}
              data-testid="profile-name"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Background / resume summary</span>
            <textarea
              rows={6}
              value={editing.summary ?? ''}
              maxLength={20000}
              data-testid="profile-summary"
              onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Role / call context</span>
            <textarea
              rows={4}
              value={editing.roleContext ?? ''}
              maxLength={20000}
              data-testid="profile-role-context"
              onChange={(e) => setEditing({ ...editing, roleContext: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Things to emphasize</span>
            <textarea
              rows={2}
              value={editing.emphasisNotes ?? ''}
              maxLength={8000}
              data-testid="profile-emphasis"
              onChange={(e) => setEditing({ ...editing, emphasisNotes: e.target.value })}
            />
          </label>
          <p style={{ color: contextSize > 24_000 ? 'var(--warning)' : 'var(--muted)' }}>
            {contextSize.toLocaleString()} characters (~
            {Math.round(contextSize / 4).toLocaleString()} tokens)
            {contextSize > 24_000 ? ' — this is a lot of context; responses may slow down.' : ''}
          </p>
          <div className="row">
            <button
              className="primary"
              disabled={saving || !(editing.name ?? '').trim()}
              data-testid="save-profile"
              onClick={() =>
                void save(async () => {
                  const profile = await window.cuedeck.saveProfile({
                    id: editing.id,
                    name: (editing.name ?? '').trim(),
                    summary: editing.summary ?? '',
                    roleContext: editing.roleContext ?? '',
                    emphasisNotes: editing.emphasisNotes ?? '',
                  });
                  await window.cuedeck.updatePublicSettings({
                    activeProfileId: settings.activeProfileId || profile.id,
                  });
                  setEditing(null);
                  await refresh();
                }, 'Profile saved.')
              }
            >
              Save profile
            </button>
            <button disabled={saving} onClick={() => setEditing(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : (
        <button
          disabled={saving}
          data-testid="new-profile"
          onClick={() => setEditing({ name: '', summary: '', roleContext: '', emphasisNotes: '' })}
        >
          New profile
        </button>
      )}
    </>
  );
}

function HistorySection({ settings, onSettingsChanged }: Props): React.JSX.Element {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState('');
  const visible = filterHistory(items, query);

  const refresh = async () => setItems(await window.cuedeck.listHistory());
  useEffect(() => {
    void refresh();
  }, [settings.historyEnabled]);

  const update = async (patch: Partial<PublicSettings>) => {
    await window.cuedeck.updatePublicSettings(patch);
    await onSettingsChanged();
  };

  const download = (filename: string, content: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <h1>History</h1>
      <label className="row">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={settings.historyEnabled}
          onChange={(e) => void update({ historyEnabled: e.target.checked })}
          data-testid="history-toggle"
        />
        <span>
          Save transcripts and responses locally (off by default; raw audio is never saved)
        </span>
      </label>
      <label className="field">
        <span>Keep history for</span>
        <select
          value={settings.historyRetentionDays}
          onChange={(e) =>
            void update({
              historyRetentionDays: Number(
                e.target.value,
              ) as PublicSettings['historyRetentionDays'],
            })
          }
        >
          <option value={1}>1 day</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={0}>Do not keep (session only)</option>
        </select>
      </label>
      <div className="row">
        <button
          className="small"
          disabled={items.length === 0}
          onClick={async () => {
            const all = await window.cuedeck.exportHistory();
            download('cuedeck-history.json', JSON.stringify(all, null, 2), 'application/json');
          }}
        >
          Export JSON
        </button>
        <button
          className="small"
          disabled={items.length === 0}
          onClick={async () => {
            const all = await window.cuedeck.exportHistory();
            const md = all
              .map(
                (i) =>
                  `## ${i.createdAt}\n\n**Heard:** ${i.transcript}\n\n**Response:** ${i.answer}\n`,
              )
              .join('\n');
            download('cuedeck-history.md', md, 'text/markdown');
          }}
        >
          Export Markdown
        </button>
        <button
          className="small danger"
          disabled={items.length === 0}
          onClick={async () => {
            await window.cuedeck.clearHistory();
            await refresh();
          }}
        >
          Delete all
        </button>
      </div>
      {items.length > 0 && (
        <label className="field">
          <span>
            Search saved sessions
            {query.trim() !== '' ? ` — ${visible.length} of ${items.length} shown` : ''}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by any words in the transcript or response"
            data-testid="history-search"
          />
        </label>
      )}
      <table className="history">
        <tbody>
          {visible.map((i) => (
            <tr key={i.id}>
              <td>{new Date(i.createdAt).toLocaleString()}</td>
              <td>
                <div>
                  <strong>{i.transcript.slice(0, 120)}</strong>
                </div>
                <div>{i.answer.slice(0, 160)}</div>
              </td>
              <td>
                <button
                  className="small danger"
                  onClick={async () => {
                    await window.cuedeck.deleteHistoryItem(i.id);
                    await refresh();
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {settings.historyEnabled && items.length === 0 && <p>No saved sessions yet.</p>}
      {items.length > 0 && visible.length === 0 && <p>No sessions match your search.</p>}
    </>
  );
}

function DiagnosticsSection(): React.JSX.Element {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [includeTranscripts, setIncludeTranscripts] = useState(false);
  const [includeProfile, setIncludeProfile] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.cuedeck.getDiagnostics().then(setReport);
  }, []);

  return (
    <>
      <h1>Diagnostics</h1>
      {report && (
        <section className="card">
          <p>
            CueDeck {report.appVersion} • Electron {report.electronVersion} • {report.platform}{' '}
            {report.osVersion}
          </p>
          <p>
            STT: {report.sttProviderId} • LLM: {report.llmProviderId} • Local model:{' '}
            {report.localModelStatus}
          </p>
          <h2>Recent errors (redacted)</h2>
          {report.recentErrors.length === 0 ? (
            <p>None.</p>
          ) : (
            <ul>
              {report.recentErrors.map((e, i) => (
                <li key={i}>
                  {e.at} [{e.code}] {e.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <h2>Export</h2>
      <p>
        Exports never include API keys. Transcripts and profile text are excluded unless you select
        them.
      </p>
      <label className="row">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={includeTranscripts}
          onChange={(e) => setIncludeTranscripts(e.target.checked)}
        />
        <span>Include recent transcripts (only if history is enabled)</span>
      </label>
      <label className="row">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={includeProfile}
          onChange={(e) => setIncludeProfile(e.target.checked)}
        />
        <span>Include active profile text</span>
      </label>
      <button
        onClick={async () => {
          const text = await window.cuedeck.exportDiagnostics({
            includeTranscripts,
            includeProfile,
          });
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? 'Copied ✓' : 'Copy diagnostics to clipboard'}
      </button>
    </>
  );
}

function AboutSection(): React.JSX.Element {
  return (
    <>
      <h1>Privacy &amp; consent</h1>
      <section className="card">
        <h2>Recording consent</h2>
        <p>
          You are responsible for obtaining participant consent and following the laws and rules
          that apply to your calls, interviews, and jurisdiction. CueDeck always shows a recording
          indicator while capture is active, never records automatically, and has no feature that
          hides it from screen sharing or recording.
        </p>
      </section>
      <section className="card">
        <h2>Permitted use</h2>
        <p>
          CueDeck is for mock interviews, rehearsal, accessibility support, and disclosed assistance
          on permitted calls. It is not for proctored assessments or any setting where outside help
          is prohibited. Responses are grounded in the profile you provide and the app instructs
          models never to invent experience.
        </p>
      </section>
      <section className="card">
        <h2>Where data lives</h2>
        <p>
          In local mode nothing leaves this computer. Optional cloud providers receive only the
          current clip or transcript plus your personal instructions, active profile, and notes.
          Expansions include their reference answer; conversation memory includes recent exchanges
          when enabled. Each provider shows its data-use policy before you enable it. History is off
          by default. There is no telemetry.
        </p>
      </section>
    </>
  );
}
