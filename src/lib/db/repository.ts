import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  MessageRecord,
  ProgramPhase,
  SessionRecord,
  UsageEventRecord,
  UsageEventType,
} from "@/types";
import { createInitialState } from "@/lib/state/session-state";
import { SupabaseRepository } from "./supabase-repository";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface CreateSessionParams {
  phase?: ProgramPhase;
  promptVersion?: string;
  initialState?: Record<string, unknown>;
}

export interface CreateMessageParams {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  providerRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface CreateUsageEventParams {
  sessionId?: string | null;
  eventType: UsageEventType;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
}

export interface DatabaseState {
  sessions: Record<string, SessionRecord>;
  messages: MessageRecord[];
  usageEvents: UsageEventRecord[];
}

export interface SessionRepository {
  createSession(
    params?: CreateSessionParams
  ): Promise<{ session: SessionRecord; resumeToken: string }>;
  getSessionById(sessionId: string): Promise<SessionRecord | null>;
  verifySessionToken(sessionId: string, rawToken: string): Promise<boolean>;
  updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "phase" | "stateJson" | "promptVersion">>
  ): Promise<SessionRecord | null>;
  softDeleteSession(sessionId: string, rawToken: string): Promise<boolean>;
  createMessage(params: CreateMessageParams): Promise<MessageRecord | null>;
  getMessagesBySessionId(sessionId: string): Promise<MessageRecord[]>;
  getTurnCount(sessionId: string): Promise<number>;
  createUsageEvent(params: CreateUsageEventParams): Promise<UsageEventRecord>;
  getUsageEventsBySessionId(sessionId: string): Promise<UsageEventRecord[]>;
}

export class JsonFileRepository implements SessionRepository {
  private filePath: string;
  private state: DatabaseState;
  private isPersisted: boolean;

  constructor(customFilePath?: string) {
    const dataDir = process.env.VERCEL
      ? path.join("/tmp", "honneo-data")
      : path.resolve(process.cwd(), "data");
    this.filePath = customFilePath || path.join(dataDir, "honneo-db.json");
    this.isPersisted = !customFilePath?.includes(":memory:");

    this.state = {
      sessions: {},
      messages: [],
      usageEvents: [],
    };

    if (this.isPersisted) {
      this.load();
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.state = JSON.parse(raw);
      }
    } catch (err) {
      console.warn("Could not load local database file, using empty state:", err);
    }
  }

  private save(): void {
    if (!this.isPersisted) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save local database file:", err);
    }
  }

  // ==========================================
  // Sessions
  // ==========================================

  public async createSession(
    params?: CreateSessionParams
  ): Promise<{ session: SessionRecord; resumeToken: string }> {
    const sessionId = crypto.randomUUID();
    const resumeToken = crypto.randomBytes(24).toString("hex");
    const resumeTokenHash = hashToken(resumeToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const phase = params?.phase || "speak";
    const session: SessionRecord = {
      id: sessionId,
      resumeTokenHash,
      phase,
      stateJson: params?.initialState || (createInitialState(phase) as unknown as Record<string, unknown>),
      promptVersion: params?.promptVersion || "v1.0",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      deletedAt: null,
    };

    this.state.sessions[sessionId] = session;
    this.save();

    await this.createUsageEvent({
      sessionId,
      eventType: "session_created",
    });

    return { session, resumeToken };
  }

  public async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    const session = this.state.sessions[sessionId];
    if (!session || session.deletedAt !== null) {
      return null;
    }
    return { ...session };
  }

  public async verifySessionToken(
    sessionId: string,
    rawToken: string
  ): Promise<boolean> {
    const session = await this.getSessionById(sessionId);
    if (!session) return false;

    const computedHash = hashToken(rawToken);
    return computedHash === session.resumeTokenHash;
  }

  public async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "phase" | "stateJson" | "promptVersion">>
  ): Promise<SessionRecord | null> {
    const session = this.state.sessions[sessionId];
    if (!session || session.deletedAt !== null) {
      return null;
    }

    const updated: SessionRecord = {
      ...session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.state.sessions[sessionId] = updated;
    this.save();
    return { ...updated };
  }

  public async softDeleteSession(
    sessionId: string,
    rawToken: string
  ): Promise<boolean> {
    const isOwner = await this.verifySessionToken(sessionId, rawToken);
    if (!isOwner) return false;

    const session = this.state.sessions[sessionId];
    if (!session || session.deletedAt !== null) return false;

    session.deletedAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();
    this.save();

    await this.createUsageEvent({
      sessionId,
      eventType: "session_deleted",
    });

    return true;
  }

  // ==========================================
  // Messages
  // ==========================================

  public async createMessage(
    params: CreateMessageParams
  ): Promise<MessageRecord | null> {
    const session = await this.getSessionById(params.sessionId);
    if (!session) return null;

    // 現在のセッションのメッセージ数 + 1 をシーケンス番号とする
    const currentSeq = this.state.messages.filter(
      (m) => m.sessionId === params.sessionId
    ).length;

    const message: MessageRecord = {
      id: crypto.randomUUID(),
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      sequenceNo: currentSeq + 1,
      providerRequestId: params.providerRequestId || null,
      inputTokens: params.inputTokens || null,
      outputTokens: params.outputTokens || null,
      createdAt: new Date().toISOString(),
    };

    this.state.messages.push(message);

    // セッションの updatedAt を更新
    session.updatedAt = new Date().toISOString();
    this.save();

    return { ...message };
  }

  public async getMessagesBySessionId(
    sessionId: string
  ): Promise<MessageRecord[]> {
    const session = await this.getSessionById(sessionId);
    if (!session) return [];

    return this.state.messages
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
      .map((m) => ({ ...m }));
  }

  public async getTurnCount(sessionId: string): Promise<number> {
    return this.state.messages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant"
    ).length;
  }

  // ==========================================
  // Usage Events
  // ==========================================

  public async createUsageEvent(
    params: CreateUsageEventParams
  ): Promise<UsageEventRecord> {
    const event: UsageEventRecord = {
      id: crypto.randomUUID(),
      sessionId: params.sessionId || null,
      eventType: params.eventType,
      model: params.model || null,
      inputTokens: params.inputTokens || null,
      outputTokens: params.outputTokens || null,
      latencyMs: params.latencyMs || null,
      createdAt: new Date().toISOString(),
    };

    this.state.usageEvents.push(event);
    this.save();
    return { ...event };
  }

  public async getUsageEventsBySessionId(
    sessionId: string
  ): Promise<UsageEventRecord[]> {
    return this.state.usageEvents
      .filter((e) => e.sessionId === sessionId)
      .map((e) => ({ ...e }));
  }
}

// デフォルトのリポジトリシングルトンインスタンス
let defaultRepo: SessionRepository | null = null;

export function getRepository(): SessionRepository {
  if (defaultRepo) {
    return defaultRepo;
  }

  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_KEY;

  if (supabaseUrl && supabaseKey) {
    console.log("[DB] Using SupabaseRepository. Target URL:", supabaseUrl.slice(0, 15) + "...");
    defaultRepo = new SupabaseRepository(supabaseUrl, supabaseKey);
    return defaultRepo;
  }

  console.warn(
    "[DB] WARNING: Supabase is not configured (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing). Falling back to JsonFileRepository (Ephemeral in serverless!)."
  );
  defaultRepo = new JsonFileRepository();
  return defaultRepo;
}

export function setRepositoryForTesting(repo: SessionRepository | null): void {
  defaultRepo = repo;
}
