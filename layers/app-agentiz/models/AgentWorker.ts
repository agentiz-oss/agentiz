import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';
import { AdminizerField, AdminizerModel } from '@nodeknit/app-adminizer';
import type {
  AgentWorkerCapabilities,
  AgentWorkerContactState,
  AgentWorkerExecutor,
  AgentWorkerKind,
  AgentWorkerStatus,
  AgentWorkerWorkspace,
} from '../types/agentiz';
import { resolveWorkspaceGitGrant, type WorkspaceGitGrant } from '../lib/workspaceGit';
import type { ActiveHoursSchedule } from '../lib/activeHours';

/** A worker that has not touched the API for this long is shown as offline. */
const OFFLINE_AFTER_MS = 5 * 60 * 1000;

/**
 * A worker identity, modelled on a GitLab runner. Workers hold sensitive material (job snapshots
 * with task text, prompts and repository coordinates), so a worker is a record an admin creates
 * deliberately, never anyone who happens to know a shared token.
 *
 * The admin creates it in the panel and gets its token once, on screen; the worker is started with
 * that token and calls `POST /register` to report which machine it runs on. The plain token never
 * reaches the database — only its sha256.
 */
@AdminizerModel({
  model: 'AgentWorker',
  title: 'Agentiz Workers',
  icon: 'precision_manufacturing',
  navbar: {
    visible: true,
    section: 'Agentiz',
  },
})
@Table({ tableName: 'agentiz_workers', timestamps: true })
export class AgentWorker extends Model<InferAttributes<AgentWorker>, InferCreationAttributes<AgentWorker>> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  @AdminizerField({ title: 'Name', required: true, views: { list: true, add: true, edit: true } })
  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @AdminizerField({
    title: 'Instance ID',
    tooltip: 'Stable id reported by the worker itself. Empty until the invited worker connects for the first time; afterwards it identifies the machine holding the token',
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true, unique: true })
  declare instanceId: string | null;

  @AdminizerField({
    title: 'Kind',
    type: 'select',
    isIn: { local: 'Local (in-process)', external: 'External' },
    views: { list: true, add: false, edit: false },
  })
  @Default('external')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'external' })
  declare kind: CreationOptional<AgentWorkerKind>;

  @AdminizerField({
    title: 'Status',
    type: 'select',
    isIn: {
      active: 'Active',
      paused: 'Paused',
      revoked: 'Revoked',
    },
    tooltip: 'Only "active" workers are given jobs; "paused" keeps the token but stops the queue',
    views: { list: true, add: false, edit: true },
  })
  @Default('active')
  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'active' })
  declare status: CreationOptional<AgentWorkerStatus>;

  /** sha256 of the personal token. The token itself is shown once, at issue time, and never stored. */
  @Column({ type: DataType.STRING, allowNull: true, unique: true })
  declare tokenHash: string | null;

  @AdminizerField({
    title: 'Token',
    tooltip: 'Visible prefix of the personal token; the secret itself is stored only as a hash',
    views: { list: true, add: false, edit: false },
  })
  @Column({ type: DataType.STRING, allowNull: true })
  declare tokenPrefix: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare tokenIssuedAt: Date | null;

  @AdminizerField({ title: 'Created by', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare createdBy: string | null;

  @AdminizerField({
    title: 'Allowed projects',
    type: 'jsoneditor',
    tooltip: 'Array of AgentProject ids this worker may claim jobs for. Empty/null = every project.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare allowedProjectIds: string[] | null;

  @AdminizerField({
    title: 'Allowed repositories',
    type: 'jsoneditor',
    tooltip: 'Array of AgentRepository ids this worker may claim jobs for. Empty/null = every repository of the allowed projects.',
    views: { list: false, add: true, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare allowedRepositoryIds: string[] | null;

  @AdminizerField({
    title: 'Workspaces',
    type: 'jsoneditor',
    tooltip: 'Prepared directories: [{ key, path, label?, description?, projectId?, git?: { pushEnabled: true, remote?: "origin" } }]. Git push is an explicit operator grant. projectId binds the directory to one project: specs of any other project are then refused.',
    views: { list: false, add: false, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare workspaces: AgentWorkerWorkspace[] | null;

  @AdminizerField({
    title: 'Git push roots',
    type: 'jsoneditor',
    tooltip: 'Absolute path prefixes this machine\'s operator allows Git push from, e.g. ["/srv/projects"]. A pipeline may then name any directory below one of them and commit from it. Empty = no pipeline may push from this machine.',
    views: { list: false, add: false, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare gitPushRoots: string[] | null;

  @AdminizerField({
    title: 'Manual executors',
    type: 'jsoneditor',
    tooltip: 'Runners that may be selected when manually starting a pipeline: [{ key: "claude", title: "Claude", acpCommand: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"] }, { key: "codex", title: "Codex", acpCommand: ["npx", "-y", "@agentclientprotocol/codex-acp"] }]. The command is configured by an administrator, never accepted from the launch form.',
    views: { list: false, add: false, edit: false },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare manualExecutors: AgentWorkerExecutor[] | null;

  @AdminizerField({
    title: 'Capabilities',
    type: 'jsoneditor',
    tooltip: '{ executors?, maxConcurrency? } reported at registration',
    views: { list: false, add: false, edit: false },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare capabilities: AgentWorkerCapabilities | null;

  /**
   * How many jobs this worker may hold at once (`leased` + `running`), enforced by the claim
   * gate. Null falls back to `capabilities.maxConcurrency ?? 1`. Non-LLM jobs count too — they
   * occupy the machine's disk and CPU even though they are never limit-gated.
   */
  @AdminizerField({
    title: 'Max concurrent jobs',
    tooltip: 'Jobs this worker may hold at once. Empty = what the worker reported (default 1).',
    views: { list: false, add: false, edit: true },
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxConcurrentJobs: number | null;

  /**
   * Service window of the machine itself (a night laptop, scheduled host maintenance). Checked at
   * claim time only — it never touches job `availableAt`, so an unpinned job simply goes to
   * another worker while this one sleeps.
   */
  @AdminizerField({
    title: 'Active hours',
    type: 'jsoneditor',
    tooltip: '{ timezone: "Europe/Belgrade", windows: [{ days: ["mon"], start: "22:00", end: "06:00" }] } — when this machine takes jobs. Empty = always.',
    views: { list: false, add: false, edit: true },
  })
  @Column({ type: DataType.JSONB, allowNull: true })
  declare activeHours: ActiveHoursSchedule | null;

  /**
   * IANA zone of the worker machine, reported in capabilities at registration or set by an
   * operator. Limit providers need it to parse local reset times ("resets 3am") out of harness
   * refusal text; without it they must degrade to "time unknown" rather than guess.
   */
  @AdminizerField({ title: 'Timezone', views: { list: false, add: false, edit: true } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare timezone: string | null;

  @AdminizerField({ title: 'Version', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare version: string | null;

  @AdminizerField({ title: 'Hostname', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare hostname: string | null;

  @AdminizerField({ title: 'Last IP', views: { list: false, add: false, edit: false } })
  @Column({ type: DataType.STRING, allowNull: true })
  declare lastIp: string | null;

  @AdminizerField({ title: 'Last seen', type: 'datetime', views: { list: true, add: false, edit: false } })
  @Column({ type: DataType.DATE, allowNull: true })
  declare lastSeenAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastClaimAt: Date | null;

  @AdminizerField({ title: 'Claimed jobs', views: { list: true, add: false, edit: false } })
  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare claimedJobsCount: CreationOptional<number>;

  /** When the worker first redeemed its token and reported an instanceId. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare registeredAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;

  @AdminizerField({ title: 'Revoke reason', views: { list: false, add: false, edit: true } })
  @Column({ type: DataType.TEXT, allowNull: true })
  declare revokedReason: string | null;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;

  /** A declared directory by its key, or undefined when this worker does not offer it (any more). */
  workspace(key: string): AgentWorkerWorkspace | undefined {
    return (this.workspaces ?? []).find((item) => item.key === key);
  }

  /**
   * Whether this machine's operator allows Git push from `directory`, and with which remote.
   *
   * A declared workspace's own `git` block and the `gitPushRoots` prefixes are two ways of holding
   * the same grant — see `lib/workspaceGit.ts`. Nothing in a pipeline spec can produce it.
   */
  gitPushGrant(directory: string, declared?: AgentWorkerWorkspace | null): WorkspaceGitGrant | null {
    return resolveWorkspaceGitGrant(directory, this.gitPushRoots, declared);
  }

  /** Empty/absent allowlist means "every project". */
  canClaimProject(projectId: string): boolean {
    if (!this.allowedProjectIds || this.allowedProjectIds.length === 0) return true;
    return this.allowedProjectIds.includes(projectId);
  }

  /**
   * Empty/absent allowlist means "every repository of the allowed projects". Both allowlists have
   * to pass.
   *
   * A job with no repository at all is never restricted: `finalAction: none` produces exactly such
   * a job, and a worker with a narrow repository allowlist would otherwise be unable to run a
   * pipeline that never touches git.
   */
  canClaimRepository(repositoryId: string | null): boolean {
    if (!this.allowedRepositoryIds || this.allowedRepositoryIds.length === 0) return true;
    if (!repositoryId) return true;
    return this.allowedRepositoryIds.includes(repositoryId);
  }

  /** The concurrency cap the claim gate enforces: operator's setting, else the worker's report, else 1. */
  effectiveMaxConcurrentJobs(): number {
    const configured = this.maxConcurrentJobs ?? this.capabilities?.maxConcurrency ?? 1;
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1;
  }

  /**
   * Same idea as a GitLab runner's online/offline dot: a worker polls for jobs continuously, so a
   * long gap since the last request means nobody is running it, whatever its status says.
   */
  contactState(now: Date = new Date(), offlineAfterMs = OFFLINE_AFTER_MS): AgentWorkerContactState {
    if (!this.lastSeenAt) return 'never_contacted';
    return now.getTime() - new Date(this.lastSeenAt).getTime() <= offlineAfterMs ? 'online' : 'offline';
  }
}
