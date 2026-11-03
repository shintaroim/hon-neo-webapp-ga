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

export class ResilientRepository implements SessionRepository {
  private primary: SessionRepository;
  private fallback: SessionRepository;
  private primaryFailed = false;

  constructor(primary: SessionRepository, fallback: SessionRepository) {
    this.primary = primary;
    this.fallback = fallback;
  }

  private isNetworkOrTableError(err: unknown): boolean {
    const msg = String(err);
    return (
      msg.includes("fetch failed") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("relation") || // table doesn't exist
      msg.includes("Failed to create session in Supabase")
    );
  }

  public async createSession(
    params?: CreateSessionParams
  ): Promise<{ session: SessionRecord; resumeToken: string }> {
    if (!this.primaryFailed) {
      try {
        return await this.primary.createSession(params);
      } catch (err) {
        console.warn("[DB] Primary repository failed createSession, falling back to JsonFileRepository:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.createSession(params);
  }

  public async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    if (!this.primaryFailed) {
      try {
        const res = await this.primary.getSessionById(sessionId);
        if (res) return res;
      } catch (err) {
        console.warn("[DB] Primary repository failed getSessionById:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.getSessionById(sessionId);
  }

  public async verifySessionToken(sessionId: string, rawToken: string): Promise<boolean> {
    if (!this.primaryFailed) {
      try {
        const valid = await this.primary.verifySessionToken(sessionId, rawToken);
        if (valid) return true;
      } catch (err) {
        console.warn("[DB] Primary repository failed verifySessionToken:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.verifySessionToken(sessionId, rawToken);
  }

  public async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "phase" | "stateJson" | "promptVersion">>
  ): Promise<SessionRecord | null> {
    if (!this.primaryFailed) {
      try {
        const res = await this.primary.updateSession(sessionId, updates);
        if (res) return res;
      } catch (err) {
        console.warn("[DB] Primary repository failed updateSession:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.updateSession(sessionId, updates);
  }

  public async softDeleteSession(sessionId: string, rawToken: string): Promise<boolean> {
    if (!this.primaryFailed) {
      try {
        const res = await this.primary.softDeleteSession(sessionId, rawToken);
        if (res) return true;
      } catch (err) {
        console.warn("[DB] Primary repository failed softDeleteSession:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.softDeleteSession(sessionId, rawToken);
  }

  public async createMessage(params: CreateMessageParams): Promise<MessageRecord | null> {
    if (!this.primaryFailed) {
      try {
        const res = await this.primary.createMessage(params);
        if (res) return res;
      } catch (err) {
        console.warn("[DB] Primary repository failed createMessage:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.createMessage(params);
  }

  public async getMessagesBySessionId(sessionId: string): Promise<MessageRecord[]> {
    if (!this.primaryFailed) {
      try {
        const res = await this.primary.getMessagesBySessionId(sessionId);
        if (res && res.length > 0) return res;
      } catch (err) {
        console.warn("[DB] Primary repository failed getMessagesBySessionId:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.getMessagesBySessionId(sessionId);
  }

  public async getTurnCount(sessionId: string): Promise<number> {
    if (!this.primaryFailed) {
      try {
        return await this.primary.getTurnCount(sessionId);
      } catch (err) {
        console.warn("[DB] Primary repository failed getTurnCount:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.getTurnCount(sessionId);
  }

  public async createUsageEvent(params: CreateUsageEventParams): Promise<UsageEventRecord> {
    if (!this.primaryFailed) {
      try {
        return await this.primary.createUsageEvent(params);
      } catch (err) {
        console.warn("[DB] Primary repository failed createUsageEvent:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.createUsageEvent(params);
  }

  public async getUsageEventsBySessionId(sessionId: string): Promise<UsageEventRecord[]> {
    if (!this.primaryFailed) {
      try {
        return await this.primary.getUsageEventsBySessionId(sessionId);
      } catch (err) {
        console.warn("[DB] Primary repository failed getUsageEventsBySessionId:", err);
        if (this.isNetworkOrTableError(err)) {
          this.primaryFailed = true;
        }
      }
    }
    return this.fallback.getUsageEventsBySessionId(sessionId);
  }
}

// デフォルトのリポジトリシングルトンインスタンス
let defaultRepo: SessionRepository | null = null;

function isValidSupabaseConfig(url?: string, key?: string): boolean {
  if (!url || !key) return false;
  if (url.includes("your-project") || url.includes("example.com")) return false;
  if (!url.startsWith("https://") && !url.startsWith("http://")) return false;
  if (key.includes("your-supabase") || key.includes("mock-key") || key.length < 15) return false;
  return true;
}

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

  if (isValidSupabaseConfig(supabaseUrl, supabaseKey)) {
    console.log("[DB] Using ResilientRepository (Supabase with JsonFile fallback). Target URL:", supabaseUrl!.slice(0, 15) + "...");
    const primary = new SupabaseRepository(supabaseUrl!, supabaseKey!);
    const fallback = new JsonFileRepository();
    defaultRepo = new ResilientRepository(primary, fallback);
    return defaultRepo;
  }

  console.warn(
    "[DB] WARNING: Supabase is not configured or uses placeholder credentials. Falling back to JsonFileRepository."
  );
  defaultRepo = new JsonFileRepository();
  return defaultRepo;
}

export function setRepositoryForTesting(repo: SessionRepository | null): void {
  defaultRepo = repo;
}
