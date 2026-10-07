/** 导入会话：幂等 + 租约互斥 + 断点续传 */
export interface ImportSession {
  sessionId: string;
  /** 报告内容哈希，幂等键 */
  reportHash: string;
  reportId: string;
  status: 'running' | 'done' | 'failed';
  /** 已处理条数，失败时从该断点继续 */
  cursor: number;
  total: number;
  /** 会话持有者（一次导入人/一个标签页） */
  owner: string;
  /** 租约到期时间（epoch ms），持有者崩溃后他人可接管 */
  leaseUntil: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type BeginResult =
  | { type: 'started'; session: ImportSession; resumed: boolean }
  | { type: 'duplicate'; session: ImportSession }
  | { type: 'locked'; session: ImportSession };

export const IMPORT_LEASE_MS = 30_000;

/**
 * 会话存于共享存储（浏览器端为 localStorage，跨标签页可见；
 * 生产环境对应数据库唯一约束 reportHash + 租约列）。
 */
export class ImportSessionStore {
  constructor(
    private storage: KeyValueStorage,
    private key = 'a11y-scan-sessions-v1',
    private now: () => number = Date.now,
    private newId: () => string = () => `session-${Math.random().toString(36).slice(2, 10)}`
  ) {}

  private readAll(): Record<string, ImportSession> {
    try {
      return JSON.parse(this.storage.getItem(this.key) ?? '{}') as Record<string, ImportSession>;
    } catch {
      return {};
    }
  }

  private writeAll(sessions: Record<string, ImportSession>): void {
    this.storage.setItem(this.key, JSON.stringify(sessions));
  }

  get(reportHash: string): ImportSession | undefined {
    return this.readAll()[reportHash];
  }

  /**
   * 开始或续传一次导入。同一份报告：
   * - 已完成 → duplicate，先到者生效，不重复写入；
   * - 进行中且租约有效（别人持有）→ locked；
   * - 失败 / 租约过期 / 自己持有 → 从 cursor 断点继续。
   */
  beginOrResume(reportHash: string, reportId: string, total: number, owner: string): BeginResult {
    const sessions = this.readAll();
    const existing = sessions[reportHash];
    const now = this.now();
    if (existing) {
      if (existing.status === 'done') return { type: 'duplicate', session: existing };
      if (existing.status === 'running' && existing.leaseUntil > now && existing.owner !== owner) {
        return { type: 'locked', session: existing };
      }
      const session: ImportSession = {
        ...existing,
        status: 'running',
        owner,
        total,
        leaseUntil: now + IMPORT_LEASE_MS,
        updatedAt: new Date(now).toISOString(),
        error: undefined
      };
      this.writeAll({ ...sessions, [reportHash]: session });
      return { type: 'started', session, resumed: existing.cursor > 0 };
    }
    const iso = new Date(now).toISOString();
    const session: ImportSession = {
      sessionId: this.newId(),
      reportHash,
      reportId,
      status: 'running',
      cursor: 0,
      total,
      owner,
      leaseUntil: now + IMPORT_LEASE_MS,
      createdAt: iso,
      updatedAt: iso
    };
    this.writeAll({ ...sessions, [reportHash]: session });
    return { type: 'started', session, resumed: false };
  }

  /** 每批处理完落盘断点并续租 */
  checkpoint(reportHash: string, cursor: number): ImportSession {
    const sessions = this.readAll();
    const existing = sessions[reportHash];
    if (!existing) throw new Error(`导入会话不存在：${reportHash}`);
    const session: ImportSession = {
      ...existing,
      cursor,
      leaseUntil: this.now() + IMPORT_LEASE_MS,
      updatedAt: new Date(this.now()).toISOString()
    };
    this.writeAll({ ...sessions, [reportHash]: session });
    return session;
  }

  complete(reportHash: string): ImportSession {
    return this.finish(reportHash, 'done');
  }

  /** 失败保留 cursor，下次 beginOrResume 从断点接着做 */
  fail(reportHash: string, error: string): ImportSession {
    return this.finish(reportHash, 'failed', error);
  }

  private finish(reportHash: string, status: 'done' | 'failed', error?: string): ImportSession {
    const sessions = this.readAll();
    const existing = sessions[reportHash];
    if (!existing) throw new Error(`导入会话不存在：${reportHash}`);
    const session: ImportSession = { ...existing, status, error, updatedAt: new Date(this.now()).toISOString() };
    this.writeAll({ ...sessions, [reportHash]: session });
    return session;
  }

  clear(reportHash: string): void {
    const sessions = this.readAll();
    delete sessions[reportHash];
    this.writeAll(sessions);
  }
}

/**
 * 跨标签页互斥：优先用 Web Locks 串行化临界区，不可用时退化为直接执行
 * （localStorage 读写在同一事件循环内是同步的，单标签页内已安全）。
 */
export async function withImportLock<T>(reportHash: string, fn: () => T): Promise<T> {
  const locks = (globalThis.navigator as Navigator & { locks?: { request: (name: string, cb: () => T) => Promise<T> } } | undefined)?.locks;
  if (locks?.request) return locks.request(`a11y-import-${reportHash}`, fn);
  return fn();
}
