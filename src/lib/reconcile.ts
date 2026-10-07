/**
 * 扫描报告与人工审计问题对账模块。
 *
 * 对账规则：
 * - 扫描发现按「页面 + 元素定位 + 规则编号」配对（findingKey）。
 * - 重复导入只更新同一条记录（upsert），不产生重复问题。
 * - 与人工问题对上后两边来源都保留（source 标记为 both），人工标题、步骤、
 *   严重程度、状态一律不动，扫描证据单独存放。
 * - 人工定的严重程度优先：severityOverridden 的问题不被扫描结果覆盖；
 *   扫描规则等级变化时，只重算未被人工覆盖且未关闭的问题。
 * - 已关闭的问题不翻旧账：跳过任何更新与重算。
 * - 同一份报告同时只允许一个导入（锁 + 写后校验）。
 * - 导入按批次提交检查点，中途失败后可从断点继续。
 */

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type IssueSource = 'manual' | 'scan' | 'both';

export interface ScanFinding {
  ruleId: string;
  page: string;
  locator: string;
  message: string;
  snippet?: string;
}

export interface ScanReport {
  reportId?: string;
  scanner?: string;
  scannedAt?: string;
  findings: ScanFinding[];
}

/** 规则编号 -> 扫描默认严重程度。 */
export type RuleConfig = Record<string, Severity>;

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
  /** 来源：人工 / 扫描 / 两边对上。 */
  source: IssueSource;
  /** 由 page|locator|ruleId 组成的配对键。 */
  scanKey?: string;
  page?: string;
  locator?: string;
  ruleId?: string;
  /** 扫描侧证据，与人工 steps 分开存放。 */
  scanMessage?: string;
  scanSnippet?: string;
  /** 最近一次按规则等级算出的严重程度。 */
  scanSeverity?: Severity;
  /** 人工是否显式定过严重程度；为 true 时扫描不得覆盖。 */
  severityOverridden?: boolean;
  scanReportId?: string;
}

export interface ImportCheckpoint {
  reportKey: string;
  total: number;
  processed: number;
  createdAt: string;
  updatedAt: string;
  status: 'in-progress' | 'completed' | 'failed';
  error?: string;
}

export interface ImportLock {
  reportKey: string;
  nonce: string;
  acquiredAt: string;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  matched: number;
  skippedClosed: number;
  recomputed: number;
  total: number;
  checkpoint: ImportCheckpoint;
}

export class ImportError extends Error {
  code: 'LOCK_HELD' | 'INVALID_REPORT' | 'SIMULATED_FAILURE';
  constructor(code: ImportError['code'], message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  'color-contrast': 'serious',
  'image-alt': 'critical',
  'focus-order': 'serious',
  label: 'moderate',
  keyboard: 'serious',
  'aria-required-attr': 'critical'
};

export const SAMPLE_REPORT: ScanReport = {
  reportId: 'scan-2026-10-07-001',
  scanner: 'axe-core',
  scannedAt: '2026-10-07T08:00:00.000Z',
  findings: [
    {
      ruleId: 'color-contrast',
      page: '/checkout',
      locator: '#pay-button',
      message: '支付按钮对比度不足（2.9:1）',
      snippet: '<button id="pay-button" class="btn-primary">立即支付</button>'
    },
    {
      ruleId: 'image-alt',
      page: '/',
      locator: 'img.logo',
      message: 'Logo 图片缺少 alt 文本',
      snippet: '<img src="/logo.png" class="logo">'
    },
    {
      ruleId: 'focus-order',
      page: '/checkout',
      locator: '.modal',
      message: '弹窗打开后焦点未移入',
      snippet: '<div class="modal" role="dialog">'
    },
    {
      ruleId: 'label',
      page: '/account',
      locator: 'input[name=phone]',
      message: '手机号输入框缺少关联标签'
    }
  ]
};

const LOCK_STORAGE_KEY = 'a11y-scan-lock-v1';
const CHECKPOINT_STORAGE_KEY = 'a11y-scan-checkpoint-v1';
const LOCK_TTL_MS = 10 * 60 * 1000;

function storage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/** 配对键：页面 + 元素定位 + 规则编号，去空白后拼接。 */
export function findingKey(finding: Pick<ScanFinding, 'ruleId' | 'page' | 'locator'>): string {
  return [finding.page, finding.locator, finding.ruleId].map((part) => part.trim()).join('::');
}

/** 报告身份：优先用报告自带编号，否则用全部配对键的指纹。 */
export function reportKey(report: ScanReport): string {
  const id = report.reportId?.trim();
  if (id) return `report:${id}`;
  const fingerprint = report.findings.map(findingKey).sort().join('|');
  return `fingerprint:${hashCode(fingerprint)}`;
}

function hashCode(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function newNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 尝试获取报告导入锁。
 * 写入后立刻回读校验 nonce：两个标签页同时写入时，回读不一致的一方判定失败，
 * 保证同一份报告只有先到的导入生效。
 */
export function acquireLock(reportKey: string, nonce: string): boolean {
  const store = storage();
  if (!store) return true;
  const raw = store.getItem(LOCK_STORAGE_KEY);
  if (raw) {
    try {
      const lock = JSON.parse(raw) as ImportLock;
      if (lock.reportKey === reportKey && Date.now() - new Date(lock.acquiredAt).getTime() < LOCK_TTL_MS) {
        return false;
      }
    } catch {
      // 锁记录损坏，直接接管。
    }
  }
  store.setItem(LOCK_STORAGE_KEY, JSON.stringify({ reportKey, nonce, acquiredAt: new Date().toISOString() }));
  try {
    const confirmed = JSON.parse(store.getItem(LOCK_STORAGE_KEY) ?? 'null') as ImportLock | null;
    return confirmed?.nonce === nonce;
  } catch {
    return false;
  }
}

export function releaseLock(reportKey: string, nonce: string): void {
  const store = storage();
  if (!store) return;
  try {
    const lock = JSON.parse(store.getItem(LOCK_STORAGE_KEY) ?? 'null') as ImportLock | null;
    if (lock?.nonce === nonce) store.removeItem(LOCK_STORAGE_KEY);
  } catch {
    // 忽略清理失败。
  }
}

export function currentLock(): ImportLock | null {
  const store = storage();
  if (!store) return null;
  try {
    const lock = JSON.parse(store.getItem(LOCK_STORAGE_KEY) ?? 'null') as ImportLock | null;
    if (!lock) return null;
    if (Date.now() - new Date(lock.acquiredAt).getTime() >= LOCK_TTL_MS) return null;
    return lock;
  } catch {
    return null;
  }
}

export function loadCheckpoint(key: string): ImportCheckpoint | null {
  const store = storage();
  if (!store) return null;
  try {
    const checkpoint = JSON.parse(store.getItem(CHECKPOINT_STORAGE_KEY) ?? 'null') as ImportCheckpoint | null;
    if (!checkpoint || checkpoint.reportKey !== key) return null;
    return checkpoint;
  } catch {
    return null;
  }
}

export function latestCheckpoint(): ImportCheckpoint | null {
  const store = storage();
  if (!store) return null;
  try {
    return JSON.parse(store.getItem(CHECKPOINT_STORAGE_KEY) ?? 'null') as ImportCheckpoint | null;
  } catch {
    return null;
  }
}

export function saveCheckpoint(checkpoint: ImportCheckpoint): void {
  const store = storage();
  if (!store) return;
  store.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(checkpoint));
}

export function clearCheckpoint(): void {
  const store = storage();
  if (!store) return;
  store.removeItem(CHECKPOINT_STORAGE_KEY);
}

/** 解析并校验扫描报告文本。 */
export function parseReport(text: string): ScanReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('INVALID_REPORT', '报告不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ScanReport).findings)) {
    throw new ImportError('INVALID_REPORT', '报告格式不正确：缺少 findings 数组');
  }
  const report = parsed as ScanReport;
  report.findings.forEach((finding, index) => {
    if (!finding || typeof finding.ruleId !== 'string' || typeof finding.page !== 'string' || typeof finding.locator !== 'string') {
      throw new ImportError('INVALID_REPORT', `第 ${index + 1} 条发现必须包含 ruleId、page、locator`);
    }
  });
  return report;
}

const SEVERITIES: Severity[] = ['critical', 'serious', 'moderate', 'minor'];

/** 解析并校验规则等级配置。 */
export function parseRuleConfig(text: string): RuleConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('INVALID_REPORT', '规则等级配置不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ImportError('INVALID_REPORT', '规则等级配置格式不正确');
  }
  for (const [ruleId, severity] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity as Severity)) {
      throw new ImportError('INVALID_REPORT', `规则 ${ruleId} 的等级 ${String(severity)} 不合法`);
    }
  }
  return parsed as RuleConfig;
}

function applyFinding(
  draft: AuditIssue[],
  finding: ScanFinding,
  report: ScanReport,
  ruleConfig: RuleConfig,
  result: ReconcileResult
): void {
  const key = findingKey(finding);
  const index = draft.findIndex((issue) => issue.scanKey === key);
  const now = new Date().toISOString();

  if (index >= 0) {
    const existing = draft[index];
    // 已关闭的不翻旧账：任何字段都不动。
    if (existing.status === 'closed') {
      result.skippedClosed += 1;
      return;
    }
    const patch: Partial<AuditIssue> = {
      // 人工问题被扫描对上后，两边来源都留着。
      source: existing.source === 'manual' ? 'both' : existing.source,
      scanMessage: finding.message,
      scanSnippet: finding.snippet ?? existing.scanSnippet,
      scanReportId: report.reportId ?? existing.scanReportId,
      page: finding.page,
      locator: finding.locator,
      ruleId: finding.ruleId,
      scanKey: key,
      updatedAt: now
    };
    // 标题与复现步骤只覆盖纯扫描来源的记录，人工结论保留。
    if (existing.source === 'scan') {
      patch.title = finding.message || existing.title;
      patch.steps = finding.snippet ?? existing.steps;
    }
    // 人工定的严重程度优先；未覆盖时按当前规则等级重算。
    if (!existing.severityOverridden) {
      const severity = ruleConfig[finding.ruleId] ?? 'moderate';
      if (existing.severity !== severity) result.recomputed += 1;
      patch.severity = severity;
      patch.scanSeverity = severity;
    }
    draft[index] = { ...existing, ...patch };
    result.updated += 1;
    if (existing.source === 'manual') result.matched += 1;
    return;
  }

  const severity = ruleConfig[finding.ruleId] ?? 'moderate';
  draft.push({
    id: newNonce(),
    title: finding.message || `${finding.ruleId} @ ${finding.page}`,
    flow: finding.page,
    steps: finding.snippet ?? '',
    impactGroup: '待确认',
    severity,
    status: 'open',
    fixNote: '',
    retestNote: '',
    updatedAt: now,
    source: 'scan',
    scanKey: key,
    page: finding.page,
    locator: finding.locator,
    ruleId: finding.ruleId,
    scanMessage: finding.message,
    scanSnippet: finding.snippet,
    scanSeverity: severity,
    severityOverridden: false,
    scanReportId: report.reportId
  });
  result.created += 1;
}

export interface ReconcileOptions {
  batchSize?: number;
  nonce?: string;
  /** 演示用：处理完第几个批次后模拟中断。 */
  failAfterBatches?: number;
}

/**
 * 对账导入：按批次处理，每批提交检查点并持久化中间状态。
 * 同一份报告已在导入中时抛出 LOCK_HELD；存在未完成检查点时从断点继续。
 */
export async function reconcileReport(
  issues: AuditIssue[],
  report: ScanReport,
  ruleConfig: RuleConfig,
  persist: (issues: AuditIssue[]) => void,
  options: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const batchSize = options.batchSize ?? 20;
  const nonce = options.nonce ?? newNonce();
  const rKey = reportKey(report);

  if (!acquireLock(rKey, nonce)) {
    throw new ImportError('LOCK_HELD', '同一份报告正在导入中，请等待当前导入完成');
  }

  let checkpoint = loadCheckpoint(rKey);
  const resuming = checkpoint !== null && (checkpoint.status === 'in-progress' || checkpoint.status === 'failed');
  if (!checkpoint || checkpoint.reportKey !== rKey) {
    checkpoint = {
      reportKey: rKey,
      total: report.findings.length,
      processed: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'in-progress'
    };
  } else {
    checkpoint.status = 'in-progress';
    checkpoint.updatedAt = new Date().toISOString();
  }
  saveCheckpoint(checkpoint);

  const result: ReconcileResult = {
    created: 0,
    updated: 0,
    matched: 0,
    skippedClosed: 0,
    recomputed: 0,
    total: report.findings.length,
    checkpoint
  };
  const draft = issues.map((issue) => ({ ...issue }));
  const startIndex = resuming ? checkpoint.processed : 0;

  try {
    let batchCount = 0;
    for (let i = startIndex; i < report.findings.length; i += batchSize) {
      const batch = report.findings.slice(i, i + batchSize);
      for (const finding of batch) {
        applyFinding(draft, finding, report, ruleConfig, result);
      }
      checkpoint.processed = Math.min(i + batchSize, report.findings.length);
      checkpoint.updatedAt = new Date().toISOString();
      saveCheckpoint(checkpoint);
      persist(draft);
      batchCount += 1;
      if (options.failAfterBatches && batchCount >= options.failAfterBatches) {
        throw new ImportError('SIMULATED_FAILURE', `模拟中途失败：导入在第 ${batchCount} 批后中断`);
      }
      // 让出事件循环，使批次间隔可观察。
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    checkpoint.status = 'completed';
    checkpoint.updatedAt = new Date().toISOString();
    saveCheckpoint(checkpoint);
  } catch (error) {
    checkpoint.status = 'failed';
    checkpoint.error = (error as Error).message;
    checkpoint.updatedAt = new Date().toISOString();
    saveCheckpoint(checkpoint);
    throw error;
  } finally {
    releaseLock(rKey, nonce);
  }

  result.checkpoint = checkpoint;
  return result;
}

/**
 * 规则等级变化后重算旧结论：
 * 只动未关闭、未被人工覆盖且带扫描配对键的问题；已关闭的不翻旧账。
 */
export function recomputeSeverities(issues: AuditIssue[], ruleConfig: RuleConfig): {
  issues: AuditIssue[];
  recomputed: number;
} {
  let recomputed = 0;
  const now = new Date().toISOString();
  const next = issues.map((issue) => {
    if (issue.status === 'closed') return issue;
    if (issue.severityOverridden || !issue.ruleId) return issue;
    const severity = ruleConfig[issue.ruleId] ?? 'moderate';
    if (issue.severity === severity) return issue;
    recomputed += 1;
    return { ...issue, severity, scanSeverity: severity, updatedAt: now };
  });
  return { issues: next, recomputed };
}

/** 为旧版本地数据补齐来源字段。 */
export function migrateIssue(raw: Partial<AuditIssue>): AuditIssue {
  return {
    id: raw.id ?? newNonce(),
    title: raw.title ?? '未命名问题',
    flow: raw.flow ?? '',
    steps: raw.steps ?? '',
    impactGroup: raw.impactGroup ?? '待确认',
    severity: raw.severity ?? 'moderate',
    status: raw.status ?? 'open',
    canonicalId: raw.canonicalId,
    fixNote: raw.fixNote ?? '',
    retestNote: raw.retestNote ?? '',
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    source: raw.source ?? 'manual',
    scanKey: raw.scanKey,
    page: raw.page,
    locator: raw.locator,
    ruleId: raw.ruleId,
    scanMessage: raw.scanMessage,
    scanSnippet: raw.scanSnippet,
    scanSeverity: raw.scanSeverity,
    severityOverridden: raw.severityOverridden ?? true,
    scanReportId: raw.scanReportId
  };
}
