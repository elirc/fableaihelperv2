import React, { useEffect, useState } from 'react';
import type {
  DiagnosticsReport,
  HistoryItem,
  ModelSummary,
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

type Section = 'general' | 'providers' | 'profiles' | 'history' | 'diagnostics' | 'about';

export function Preferences({ settings, onSettingsChanged }: Props): React.JSX.Element {
  const [section, setSection] = useState<Section>('general');
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

  const loadModels = async (providerId: string) => {
    const list = await window.cuedeck.listModels(providerId).catch(() => []);
    setModels((m) => ({ ...m, [providerId]: list }));
  };

  const sttProviders = providers.filter((p) => p.kind === 'stt');
  const llmProviders = providers.filter((p) => p.kind === 'llm');
  // One key section per cloud account, derived from provider metadata so a
  // newly registered provider shows up without touching this component.
  const cloudProviders = [
    ...new Set(providers.filter((p) => p.location === 'cloud').map((p) => p.credentialId ?? p.id)),
  ];
  const ollamaIsRemote = !/^https?:\/\/(localhost|127\.|\[::1\])/.test(ollamaUrl);

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
          When a cloud provider is selected, it receives: the current audio clip (STT) or
          transcript, your active profile, role context, and session notes. Nothing else — no
          history, no other profiles, no screen content.
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
            onLoad={() => void loadModels('local-whisper')}
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
        {(models[settings.llmProviderId] ?? []).length > 0 && (
          <label className="field">
            <span>Model</span>
            <select
              value={settings.llmModelId}
              onChange={(e) => void update({ llmModelId: e.target.value })}
            >
              <option value="">Choose a model…</option>
              {(models[settings.llmProviderId] ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
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
                  this device. I understand.
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
      <p>Profiles ground responses in your real background. Stored only on this computer.</p>
      {profiles.map((p) => (
        <div
          key={p.id}
          className="card row"
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
                onClick={async () => {
                  await window.cuedeck.updatePublicSettings({ activeProfileId: p.id });
                  await onSettingsChanged();
                }}
              >
                Make active
              </button>
            )}
            <button className="small" onClick={() => setEditing(p)}>
              Edit
            </button>
            <button
              className="small danger"
              onClick={async () => {
                await window.cuedeck.deleteProfile(p.id);
                await refresh();
              }}
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
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Background / resume summary</span>
            <textarea
              rows={6}
              value={editing.summary ?? ''}
              onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Role / call context</span>
            <textarea
              rows={4}
              value={editing.roleContext ?? ''}
              onChange={(e) => setEditing({ ...editing, roleContext: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Things to emphasize</span>
            <textarea
              rows={2}
              value={editing.emphasisNotes ?? ''}
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
              disabled={!(editing.name ?? '').trim()}
              onClick={async () => {
                await window.cuedeck.saveProfile({
                  id: editing.id,
                  name: (editing.name ?? '').trim(),
                  summary: editing.summary ?? '',
                  roleContext: editing.roleContext ?? '',
                  emphasisNotes: editing.emphasisNotes ?? '',
                });
                setEditing(null);
                await refresh();
              }}
            >
              Save profile
            </button>
            <button onClick={() => setEditing(null)}>Discard</button>
          </div>
        </div>
      ) : (
        <button
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
          current clip or transcript plus your active profile and notes, and each shows its data-use
          policy before you enable it. History is off by default. There is no telemetry.
        </p>
      </section>
    </>
  );
}
