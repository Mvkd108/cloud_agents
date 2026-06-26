import postgres from "postgres";
import type {
  AgentRunRecord,
  AgentSessionRecord,
  RunEventRecord,
  RunStatus,
  SandboxInstanceRecord,
  SessionStatus,
} from "./types.ts";

export type Sql = ReturnType<typeof postgres>;

export function createSql(postgresUrl: string): Sql {
  return postgres(postgresUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export async function ensureControlPlaneSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists agent_sessions (
      id text primary key,
      user_id text not null,
      repo_url text not null,
      repo_owner text,
      repo_name text,
      branch text,
      selected_model text,
      active_sandbox_id text,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists sandbox_instances (
      id text primary key,
      session_id text not null references agent_sessions(id) on delete cascade,
      provider text not null,
      sandbox_id text not null,
      template_id text,
      snapshot_id text,
      repo_path text not null,
      lifecycle_state text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists agent_runs (
      id text primary key,
      session_id text not null references agent_sessions(id) on delete cascade,
      prompt text not null,
      status text not null default 'queued',
      model_id text,
      codex_session_id text,
      error text,
      input_tokens integer,
      output_tokens integer,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      completed_at timestamptz
    )
  `;
  await sql`
    create table if not exists run_events (
      id bigserial primary key,
      run_id text not null references agent_runs(id) on delete cascade,
      sequence integer not null,
      type text not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      unique(run_id, sequence)
    )
  `;
  await sql`
    create index if not exists run_events_run_sequence_idx
      on run_events(run_id, sequence)
  `;
  await sql`
    create index if not exists agent_runs_session_idx
      on agent_runs(session_id, created_at desc)
  `;
}

function repoParts(repoUrl: string): {
  owner: string | null;
  name: string | null;
} {
  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) {
    return { owner: null, name: null };
  }
  return { owner: match[1] ?? null, name: match[2] ?? null };
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error("Expected database row");
  }
  return row;
}

export class ControlPlaneStore {
  constructor(readonly sql: Sql) {}

  async createOrGetSession(input: {
    id?: string;
    userId: string;
    repoUrl: string;
    branch?: string;
    selectedModel?: string;
  }): Promise<AgentSessionRecord> {
    if (input.id) {
      const existing = await this.getSession(input.id);
      if (existing) {
        return existing;
      }
    }

    const id = input.id ?? crypto.randomUUID();
    const { owner, name } = repoParts(input.repoUrl);
    const rows = await this.sql<AgentSessionRecord[]>`
      insert into agent_sessions (
        id, user_id, repo_url, repo_owner, repo_name, branch, selected_model
      )
      values (
        ${id}, ${input.userId}, ${input.repoUrl}, ${owner}, ${name},
        ${input.branch ?? null}, ${input.selectedModel ?? null}
      )
      returning
        id,
        user_id as "userId",
        repo_url as "repoUrl",
        repo_owner as "repoOwner",
        repo_name as "repoName",
        branch,
        selected_model as "selectedModel",
        active_sandbox_id as "activeSandboxId",
        status,
        created_at as "createdAt",
        updated_at as "updatedAt"
    `;
    return one(rows);
  }

  async getSession(id: string): Promise<AgentSessionRecord | null> {
    const rows = await this.sql<AgentSessionRecord[]>`
      select
        id,
        user_id as "userId",
        repo_url as "repoUrl",
        repo_owner as "repoOwner",
        repo_name as "repoName",
        branch,
        selected_model as "selectedModel",
        active_sandbox_id as "activeSandboxId",
        status,
        created_at as "createdAt",
        updated_at as "updatedAt"
      from agent_sessions
      where id = ${id}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async updateSessionSandbox(params: {
    sessionId: string;
    sandboxInstanceId: string;
    status?: SessionStatus;
  }): Promise<void> {
    await this.sql`
      update agent_sessions
      set
        active_sandbox_id = ${params.sandboxInstanceId},
        status = ${params.status ?? "active"},
        updated_at = now()
      where id = ${params.sessionId}
    `;
  }

  async upsertSandboxInstance(input: {
    id?: string;
    sessionId: string;
    sandboxId: string;
    templateId?: string;
    snapshotId?: string;
    repoPath: string;
    lifecycleState: string;
  }): Promise<SandboxInstanceRecord> {
    const id = input.id ?? crypto.randomUUID();
    const rows = await this.sql<SandboxInstanceRecord[]>`
      insert into sandbox_instances (
        id, session_id, provider, sandbox_id, template_id, snapshot_id,
        repo_path, lifecycle_state
      )
      values (
        ${id}, ${input.sessionId}, 'e2b', ${input.sandboxId},
        ${input.templateId ?? null}, ${input.snapshotId ?? null},
        ${input.repoPath}, ${input.lifecycleState}
      )
      on conflict (id) do update set
        sandbox_id = excluded.sandbox_id,
        template_id = excluded.template_id,
        snapshot_id = excluded.snapshot_id,
        repo_path = excluded.repo_path,
        lifecycle_state = excluded.lifecycle_state,
        updated_at = now()
      returning
        id,
        session_id as "sessionId",
        provider,
        sandbox_id as "sandboxId",
        template_id as "templateId",
        snapshot_id as "snapshotId",
        repo_path as "repoPath",
        lifecycle_state as "lifecycleState",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `;
    return one(rows);
  }

  async getActiveSandbox(
    sessionId: string,
  ): Promise<SandboxInstanceRecord | null> {
    const rows = await this.sql<SandboxInstanceRecord[]>`
      select
        si.id,
        si.session_id as "sessionId",
        si.provider,
        si.sandbox_id as "sandboxId",
        si.template_id as "templateId",
        si.snapshot_id as "snapshotId",
        si.repo_path as "repoPath",
        si.lifecycle_state as "lifecycleState",
        si.created_at as "createdAt",
        si.updated_at as "updatedAt"
      from sandbox_instances si
      join agent_sessions s on s.active_sandbox_id = si.id
      where s.id = ${sessionId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async createRun(input: {
    sessionId: string;
    prompt: string;
    modelId?: string;
  }): Promise<AgentRunRecord> {
    const rows = await this.sql<AgentRunRecord[]>`
      insert into agent_runs (id, session_id, prompt, model_id)
      values (
        ${crypto.randomUUID()}, ${input.sessionId}, ${input.prompt},
        ${input.modelId ?? null}
      )
      returning
        id,
        session_id as "sessionId",
        prompt,
        status,
        model_id as "modelId",
        codex_session_id as "codexSessionId",
        error,
        input_tokens as "inputTokens",
        output_tokens as "outputTokens",
        created_at as "createdAt",
        started_at as "startedAt",
        completed_at as "completedAt"
    `;
    return one(rows);
  }

  async getRun(id: string): Promise<AgentRunRecord | null> {
    const rows = await this.sql<AgentRunRecord[]>`
      select
        id,
        session_id as "sessionId",
        prompt,
        status,
        model_id as "modelId",
        codex_session_id as "codexSessionId",
        error,
        input_tokens as "inputTokens",
        output_tokens as "outputTokens",
        created_at as "createdAt",
        started_at as "startedAt",
        completed_at as "completedAt"
      from agent_runs
      where id = ${id}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async updateRun(params: {
    runId: string;
    status: RunStatus;
    error?: string;
    codexSessionId?: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<void> {
    await this.sql`
      update agent_runs
      set
        status = ${params.status},
        error = coalesce(${params.error ?? null}, error),
        codex_session_id = coalesce(${params.codexSessionId ?? null}, codex_session_id),
        input_tokens = coalesce(${params.inputTokens ?? null}, input_tokens),
        output_tokens = coalesce(${params.outputTokens ?? null}, output_tokens),
        started_at = case when ${params.status} = 'running' then coalesce(started_at, now()) else started_at end,
        completed_at = case when ${params.status} in ('completed', 'failed', 'cancelled') then now() else completed_at end
      where id = ${params.runId}
    `;
  }

  async nextEventSequence(runId: string): Promise<number> {
    const rows = await this.sql<{ next: number }[]>`
      select coalesce(max(sequence), 0) + 1 as next
      from run_events
      where run_id = ${runId}
    `;
    return rows[0]?.next ?? 1;
  }

  async appendRunEvent(input: {
    runId: string;
    type: string;
    payload: unknown;
  }): Promise<RunEventRecord> {
    const sequence = await this.nextEventSequence(input.runId);
    const payload = input.payload as Parameters<Sql["json"]>[0];
    const rows = await this.sql<RunEventRecord[]>`
      insert into run_events (run_id, sequence, type, payload)
      values (${input.runId}, ${sequence}, ${input.type}, ${this.sql.json(payload)})
      returning
        id,
        run_id as "runId",
        sequence,
        type,
        payload,
        created_at as "createdAt"
    `;
    return one(rows);
  }

  async listRunEventsAfter(
    runId: string,
    afterSequence: number,
  ): Promise<RunEventRecord[]> {
    return this.sql<RunEventRecord[]>`
      select
        id,
        run_id as "runId",
        sequence,
        type,
        payload,
        created_at as "createdAt"
      from run_events
      where run_id = ${runId}
        and sequence > ${afterSequence}
      order by sequence asc
      limit 500
    `;
  }
}
