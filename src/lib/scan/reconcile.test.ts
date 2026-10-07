import { describe, expect, it } from 'vitest';
import type { AuditIssue, RuleCatalogEntry, ScanFinding, ScanReport } from './types';
import { fingerprintOf, normalizePage, normalizeRuleId, normalizeSelector, reportHash } from './fingerprint';
import { applyFinding, recomputeWithCatalog } from './reconcile';

const NOW = '2026-10-07T10:00:00.000Z';
let seq = 0;
const newId = () => `id-${++seq}`;

const catalog = new Map<string, RuleCatalogEntry>([
  ['focus-order', { ruleId: 'focus-order', title: '焦点顺序不合逻辑', wcag: 'WCAG 2.4.3', severity: 'serious', version: 1, updatedAt: NOW }],
  ['label', { ruleId: 'label', title: '表单控件缺少标签', wcag: 'WCAG 1.3.1', severity: 'critical', version: 1, updatedAt: NOW }]
]);

const report: ScanReport = { reportId: 'scan-1', tool: 'axe-core', generatedAt: NOW, findings: [] };
const finding: ScanFinding = { page: '/checkout', selector: '#dialog', ruleId: 'focus-order', summary: '焦点丢失' };

function manualIssue(patch: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'm-1',
    title: '人工问题',
    flow: '订单结算',
    steps: '复现步骤',
    impactGroup: '键盘用户',
    severity: 'minor',
    status: 'fixing',
    fixNote: '',
    retestNote: '',
    updatedAt: NOW,
    sources: [{ kind: 'manual', note: '审计员建档', at: NOW }],
    severitySource: 'manual',
    statusSource: 'manual',
    ...patch
  };
}

describe('指纹归一化', () => {
  it('页面忽略大小写、hash 与末尾斜杠', () => {
    expect(normalizePage('HTTPS://A.com/Checkout/#pay')).toBe(normalizePage('https://a.com/checkout'));
    expect(normalizePage(' /checkout/ ')).toBe('/checkout');
  });

  it('元素定位折叠空白，规则编号小写', () => {
    expect(normalizeSelector('  #a   >   .b ')).toBe('#a > .b');
    expect(normalizeRuleId(' Color-Contrast ')).toBe('color-contrast');
    expect(fingerprintOf('/a', '#x', 'R1')).toBe(fingerprintOf(' /a/ ', ' #x ', 'r1'));
  });

  it('同一报告内容哈希稳定，内容变化哈希变化', () => {
    const r1: ScanReport = { ...report, findings: [finding] };
    const r2: ScanReport = { ...report, findings: [{ ...finding, page: ' /checkout/ ' }] };
    const r3: ScanReport = { ...report, findings: [{ ...finding, summary: '别的描述' }] };
    expect(reportHash(r1)).toBe(reportHash(r2));
    expect(reportHash(r1)).not.toBe(reportHash(r3));
  });
});

describe('扫描发现对账', () => {
  it('首次导入按规则目录自动建档，扫描定级', () => {
    const result = applyFinding([], finding, { report, catalog, now: NOW, newId });
    expect(result.outcome).toBe('created');
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.severity).toBe('serious');
    expect(issue.severitySource).toBe('scan');
    expect(issue.status).toBe('open');
    expect(issue.fingerprint).toBe(fingerprintOf('/checkout', '#dialog', 'focus-order'));
    expect(issue.sources).toHaveLength(1);
  });

  it('重复导入只更新那一条：不新建、保留 firstSeenAt、刷新 lastSeenAt', () => {
    const first = applyFinding([], finding, { report, catalog, now: NOW, newId });
    const later = '2026-10-08T10:00:00.000Z';
    const second = applyFinding(first.issues, { ...finding, summary: '更新后的描述' }, { report, catalog, now: later, newId });
    expect(second.outcome).toBe('unchanged');
    expect(second.issues).toHaveLength(1);
    const source = second.issues[0].sources[0];
    expect(source.kind).toBe('scan');
    if (source.kind === 'scan') {
      expect(source.firstSeenAt).toBe(NOW);
      expect(source.lastSeenAt).toBe(later);
      expect(source.summary).toBe('更新后的描述');
    }
  });

  it('对上人工问题：双来源都留着，人工定级与状态不动', () => {
    const manual = manualIssue({ page: '/checkout', selector: '#dialog', ruleId: 'focus-order' });
    const result = applyFinding([manual], finding, { report, catalog, now: NOW, newId });
    expect(result.outcome).toBe('linked');
    expect(result.issues).toHaveLength(1);
    const linked = result.issues[0];
    expect(linked.sources.map((s) => s.kind)).toEqual(['manual', 'scan']);
    expect(linked.severity).toBe('minor');
    expect(linked.status).toBe('fixing');
    expect(linked.fingerprint).toBe(fingerprintOf('/checkout', '#dialog', 'focus-order'));
  });

  it('人工定级优先：关联后重复导入也不覆盖人工结论', () => {
    const manual = manualIssue({ page: '/checkout', selector: '#dialog', ruleId: 'focus-order' });
    const linked = applyFinding([manual], finding, { report, catalog, now: NOW, newId });
    const again = applyFinding(linked.issues, finding, { report, catalog, now: '2026-10-08T00:00:00.000Z', newId });
    expect(again.issues[0].severity).toBe('minor');
    expect(again.issues[0].status).toBe('fixing');
  });

  it('扫描定级的问题在目录等级变化后随导入重算', () => {
    const first = applyFinding([], finding, { report, catalog, now: NOW, newId });
    const stricter = new Map(catalog);
    stricter.set('focus-order', { ...catalog.get('focus-order')!, severity: 'critical', version: 2 });
    const second = applyFinding(first.issues, finding, { report, catalog: stricter, now: '2026-10-08T00:00:00.000Z', newId });
    expect(second.outcome).toBe('updated');
    expect(second.issues[0].severity).toBe('critical');
    expect(second.issues[0].ruleVersion).toBe(2);
    expect(second.events.some((e) => e.message.includes('重算'))).toBe(true);
  });

  it('已关闭的不翻旧账：只留来源痕迹，不重算不重开', () => {
    const first = applyFinding([], finding, { report, catalog, now: NOW, newId });
    const closed = first.issues.map((i) => ({ ...i, status: 'closed' as const }));
    const stricter = new Map(catalog);
    stricter.set('focus-order', { ...catalog.get('focus-order')!, severity: 'critical', version: 2 });
    const result = applyFinding(closed, finding, { report, catalog: stricter, now: '2026-10-08T00:00:00.000Z', newId });
    expect(result.outcome).toBe('skipped-closed');
    expect(result.issues[0].status).toBe('closed');
    expect(result.issues[0].severity).toBe('serious');
    const source = result.issues[0].sources[0];
    expect(source.kind === 'scan' && source.lastSeenAt).toBe('2026-10-08T00:00:00.000Z');
  });

  it('未收录的规则按 moderate 建档并记录事件', () => {
    const unknown: ScanFinding = { page: '/a', selector: '#x', ruleId: 'new-rule', summary: '新规则命中' };
    const result = applyFinding([], unknown, { report, catalog, now: NOW, newId });
    expect(result.issues[0].severity).toBe('moderate');
    expect(result.events[0].message).toContain('未收录');
  });
});

describe('规则等级变化后的重算', () => {
  it('只重算扫描定级且未关闭的问题', () => {
    const scanCreated = applyFinding([], finding, { report, catalog, now: NOW, newId }).issues;
    const manualKept = manualIssue({ id: 'm-2', page: '/checkout', selector: '#dialog', ruleId: 'focus-order' });
    const closedScan = scanCreated.map((i) => ({ ...i, id: 'c-1', status: 'closed' as const }));
    const issues = [...scanCreated, manualKept, ...closedScan];
    const stricter = new Map(catalog);
    stricter.set('focus-order', { ...catalog.get('focus-order')!, severity: 'critical', version: 2 });

    const result = recomputeWithCatalog(issues, stricter, '2026-10-09T00:00:00.000Z', newId);
    expect(result.recomputed).toBe(1);
    expect(result.issues.find((i) => i.id === scanCreated[0].id)?.severity).toBe('critical');
    expect(result.issues.find((i) => i.id === 'm-2')?.severity).toBe('minor');
    const closed = result.issues.find((i) => i.id === 'c-1');
    expect(closed?.severity).toBe('serious');
    expect(closed?.status).toBe('closed');
  });
});
