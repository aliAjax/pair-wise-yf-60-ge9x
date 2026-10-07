import type {
  AuditEvent,
  AuditIssue,
  IssueSource,
  RuleCatalogEntry,
  ScanFinding,
  ScanReport,
  Severity
} from './types';
import { fingerprintOf, normalizeRuleId } from './fingerprint';

/** 目录中未收录的规则按 moderate 建档，并在事件里说明 */
export const UNKNOWN_RULE_SEVERITY: Severity = 'moderate';

export interface ReconcileContext {
  report: ScanReport;
  catalog: ReadonlyMap<string, RuleCatalogEntry>;
  now: string;
  newId?: () => string;
}

export type FindingOutcome = 'created' | 'updated' | 'linked' | 'unchanged' | 'skipped-closed';

export interface FindingResult {
  issues: AuditIssue[];
  events: AuditEvent[];
  outcome: FindingOutcome;
  issueId: string;
}

const fallbackId = () => `issue-${Math.random().toString(36).slice(2, 10)}`;

function makeEvent(issueId: string, at: string, message: string, newId: () => string): AuditEvent {
  return { id: newId(), at, issueId, message };
}

/** 同一报告再次命中：只更新那一条来源的 lastSeenAt / 证据，保留 firstSeenAt */
function upsertScanSource(sources: IssueSource[], incoming: Extract<IssueSource, { kind: 'scan' }>): IssueSource[] {
  const index = sources.findIndex((s) => s.kind === 'scan' && s.reportId === incoming.reportId);
  if (index === -1) return [...sources, incoming];
  const existing = sources[index] as Extract<IssueSource, { kind: 'scan' }>;
  const merged: IssueSource[] = [...sources];
  merged[index] = { ...existing, lastSeenAt: incoming.lastSeenAt, summary: incoming.summary, snippet: incoming.snippet };
  return merged;
}

/**
 * 把一条扫描发现对账到问题列表。
 * 优先级：指纹精确命中（更新那一条）→ 人工问题三要素对上（关联双来源）→ 新建扫描问题。
 * 人工定的严重程度和状态永远优先；已关闭的问题只留来源痕迹，不翻旧账。
 */
export function applyFinding(issues: AuditIssue[], finding: ScanFinding, ctx: ReconcileContext): FindingResult {
  const newId = ctx.newId ?? fallbackId;
  const ruleId = normalizeRuleId(finding.ruleId);
  const rule = ctx.catalog.get(ruleId);
  const scanSeverity = rule?.severity ?? UNKNOWN_RULE_SEVERITY;
  const fp = fingerprintOf(finding.page, finding.selector, ruleId);
  const scanSource: IssueSource = {
    kind: 'scan',
    reportId: ctx.report.reportId,
    tool: ctx.report.tool,
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    summary: finding.summary,
    snippet: finding.snippet
  };

  // 1) 指纹精确命中：重复导入只更新那一条
  const existing = issues.find((issue) => issue.fingerprint === fp);
  if (existing) {
    const sources = upsertScanSource(existing.sources, scanSource);
    if (existing.status === 'closed') {
      // 已关闭不翻旧账：仅记录“扫描又见到了”，不动等级和状态
      const next = { ...existing, sources };
      return { issues: issues.map((i) => (i.id === next.id ? next : i)), events: [], outcome: 'skipped-closed', issueId: next.id };
    }
    const events: AuditEvent[] = [];
    let next: AuditIssue = { ...existing, sources };
    let materialChange = false;
    if (existing.severitySource === 'scan') {
      // 扫描定级的问题跟随规则目录；人工定级的一律不动
      if (existing.severity !== scanSeverity) {
        events.push(
          makeEvent(existing.id, ctx.now, `规则 ${ruleId} 目录等级变化，扫描结论重算：${existing.severity} → ${scanSeverity}`, newId)
        );
        next = { ...next, severity: scanSeverity };
        materialChange = true;
      }
      next = { ...next, scanSeverity, ruleVersion: rule?.version ?? existing.ruleVersion };
    }
    next = { ...next, updatedAt: ctx.now };
    return {
      issues: issues.map((i) => (i.id === next.id ? next : i)),
      events,
      outcome: materialChange ? 'updated' : 'unchanged',
      issueId: next.id
    };
  }

  // 2) 人工问题带齐定位三要素且指纹对上：关联，两边来源都留着，人工结论不动
  const manual = issues.find(
    (issue) =>
      !issue.fingerprint &&
      issue.page &&
      issue.selector &&
      issue.ruleId &&
      fingerprintOf(issue.page, issue.selector, issue.ruleId) === fp
  );
  if (manual) {
    const next: AuditIssue = { ...manual, fingerprint: fp, sources: [...manual.sources, scanSource], updatedAt: ctx.now };
    const events = [
      makeEvent(
        manual.id,
        ctx.now,
        `扫描报告 ${ctx.report.reportId} 的发现与人工问题对上（${ruleId}），双来源已保留，人工定级与状态不变`,
        newId
      )
    ];
    return { issues: issues.map((i) => (i.id === next.id ? next : i)), events, outcome: 'linked', issueId: next.id };
  }

  // 3) 全新缺陷：按规则目录自动建档
  const id = newId();
  const issue: AuditIssue = {
    id,
    title: rule ? `${rule.title}：${finding.selector}` : finding.summary || `${ruleId}：${finding.selector}`,
    flow: finding.page,
    steps: finding.summary || `扫描规则 ${ruleId} 命中，待人工补充复现步骤`,
    impactGroup: '待人工评估',
    severity: scanSeverity,
    status: 'open',
    fixNote: '',
    retestNote: '',
    updatedAt: ctx.now,
    page: finding.page,
    selector: finding.selector,
    ruleId,
    fingerprint: fp,
    sources: [scanSource],
    severitySource: 'scan',
    statusSource: 'scan',
    scanSeverity,
    ruleVersion: rule?.version
  };
  const events = [
    makeEvent(
      id,
      ctx.now,
      rule
        ? `扫描报告 ${ctx.report.reportId} 自动建档（规则 ${ruleId}，目录等级 ${scanSeverity}）`
        : `扫描报告 ${ctx.report.reportId} 自动建档（规则 ${ruleId} 未收录，暂按 ${UNKNOWN_RULE_SEVERITY}）`,
      newId
    )
  ];
  return { issues: [issue, ...issues], events, outcome: 'created', issueId: id };
}

export interface RecomputeResult {
  issues: AuditIssue[];
  events: AuditEvent[];
  recomputed: number;
}

/**
 * 规则目录等级变化后重算旧结论。
 * 只动“扫描定级且未关闭”的问题；人工定级优先，已关闭不翻旧账。
 */
export function recomputeWithCatalog(
  issues: AuditIssue[],
  catalog: ReadonlyMap<string, RuleCatalogEntry>,
  now: string,
  newId: () => string = fallbackId
): RecomputeResult {
  const events: AuditEvent[] = [];
  let recomputed = 0;
  const next = issues.map((issue) => {
    if (issue.status === 'closed') return issue;
    if (issue.severitySource !== 'scan' || !issue.ruleId) return issue;
    const rule = catalog.get(issue.ruleId);
    if (!rule) return issue;
    if (issue.severity === rule.severity && issue.ruleVersion === rule.version) return issue;
    recomputed += 1;
    if (issue.severity !== rule.severity) {
      events.push(makeEvent(issue.id, now, `规则 ${issue.ruleId} 等级调整为 ${rule.severity}，旧结论重算：${issue.severity} → ${rule.severity}`, newId));
    }
    return { ...issue, severity: rule.severity, scanSeverity: rule.severity, ruleVersion: rule.version, updatedAt: now };
  });
  return { issues: next, events, recomputed };
}
