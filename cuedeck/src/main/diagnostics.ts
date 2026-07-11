import os from 'node:os';
import type { DiagnosticsReport } from '../shared/domain';
import { redactSecrets } from '../shared/redact';

interface RecordedError {
  at: string;
  code: string;
  message: string;
}

/**
 * Diagnostics with sensitive-data redaction (spec §9.6). Recent errors are
 * kept in memory only; messages are redacted before storage so no code
 * path can export a credential.
 */
export class Diagnostics {
  private errors: RecordedError[] = [];

  constructor(
    private readonly appVersion: string,
    private readonly getProviderIds: () => Promise<{ stt: string; llm: string }>,
    private readonly getLocalModelStatus: () => string,
  ) {}

  recordError(code: string, message: string): void {
    this.errors.unshift({
      at: new Date().toISOString(),
      code,
      message: redactSecrets(message).slice(0, 500),
    });
    this.errors = this.errors.slice(0, 20);
  }

  async report(): Promise<DiagnosticsReport> {
    const providers = await this.getProviderIds();
    return {
      appVersion: this.appVersion,
      electronVersion: process.versions.electron ?? 'test',
      platform: process.platform,
      osVersion: os.release(),
      sttProviderId: providers.stt,
      llmProviderId: providers.llm,
      localModelStatus: this.getLocalModelStatus(),
      recentErrors: [...this.errors],
    };
  }

  /**
   * Export as text. Transcript/profile content is excluded unless the user
   * explicitly opted in (SET-06); this method never receives credentials.
   */
  async exportText(extra: { transcripts?: string; profile?: string } = {}): Promise<string> {
    const report = await this.report();
    const lines = [
      `CueDeck diagnostics — ${new Date().toISOString()}`,
      `App ${report.appVersion} / Electron ${report.electronVersion}`,
      `Platform ${report.platform} ${report.osVersion}`,
      `STT provider: ${report.sttProviderId}`,
      `LLM provider: ${report.llmProviderId}`,
      `Local model: ${report.localModelStatus}`,
      '',
      'Recent errors:',
      ...report.recentErrors.map((e) => `  ${e.at} [${e.code}] ${e.message}`),
    ];
    if (extra.transcripts)
      lines.push('', 'Transcripts (user-selected):', redactSecrets(extra.transcripts));
    if (extra.profile) lines.push('', 'Profile (user-selected):', redactSecrets(extra.profile));
    return redactSecrets(lines.join('\n'));
  }
}
