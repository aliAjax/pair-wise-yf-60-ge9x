export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';

/** 扫描报告中的一条发现 */
export interface ScanFinding {
  /** 页面（URL 或路由） */
  page: string;
  /** 元素定位（CSS 选择器 / xpath） */
  selector: string;
  /** 扫描规则编号，如 color-contrast */
  ruleId: string;
  /** 扫描器给出的问题描述 */
  summary: string;
  /** HTML 片段证据 */
  snippet?: string;
}

export interface ScanReport {
  reportId: string;
  tool: string;
  generatedAt: string;
  findings: ScanFinding[];
}

/** 扫描规则目录：规则等级可调，version 随等级变化递增，用于触发结论重算 */
export interface RuleCatalogEntry {
  ruleId: string;
  title: string;
  wcag: string;
  severity: Severity;
  version: number;
  updatedAt: string;
}

/** 问题来源：人工建档与扫描命中都保留，互不覆盖 */
export type IssueSource =
  | { kind: 'manual'; note: string; at: string }
  | {
      kind: 'scan';
      reportId: string;
      tool: string;
      firstSeenAt: string;
      lastSeenAt: string;
      summary: string;
      snippet?: string;
    };

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
  /** 对账定位三要素：页面 + 元素定位 + 规则编号 */
  page?: string;
  selector?: string;
  ruleId?: string;
  /** 三要素归一化后的去重指纹 */
  fingerprint?: string;
  sources: IssueSource[];
  /** 严重程度由谁定：人工优先于扫描 */
  severitySource: 'manual' | 'scan';
  /** 状态由谁推动：人工优先于扫描 */
  statusSource: 'manual' | 'scan';
  /** 最近一次按规则目录算出的扫描等级 */
  scanSeverity?: Severity;
  /** 计算时使用的规则目录版本 */
  ruleVersion?: number;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
}
