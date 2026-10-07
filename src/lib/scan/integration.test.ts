import { describe, expect, it } from 'vitest';
import type { AuditIssue, ScanReport } from './types';
import { applyFinding, recomputeWithCatalog } from './reconcile';
import { ImportSessionStore, type BeginResult, type KeyValueStorage } from './import-session';
import { fingerprintOf, reportHash } from './fingerprint';
import { defaultCatalog, sampleReport } from './defaults';

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k)
  };
}

const manualSeed: AuditIssue = {
  id: 'issue-1',
  title: '结算弹窗关闭后焦点丢失',
  flow: '订单结算',
  steps: '复现步骤',
  impactGroup: '键盘与读屏用户',
  severity: 'serious',
  status: 'triaged',
  fixNote: '',
  retestNote: '',
  updatedAt: '2026-10-06T00:00:00.000Z',
  page: '/checkout',
  selector: '#checkout-dialog',
  ruleId: 'focus-order',
  sources: [{ kind: 'manual', note: '审计员人工建档', at: '2026-10-06T00:00:00.000Z' }],
  severitySource: 'manual',
  statusSource: 'manual'
};

interface ImportRun {
  begin: BeginResult | { type: 'failed' };
  issues: AuditIssue[];
}

/** 模拟 UI 的导入循环：逐条对账、逐条落断点，可注入失败位置 */
function runImport(store: ImportSessionStore, report: ScanReport, issues: AuditIssue[], owner: string, failAt = -1): ImportRun {
  const hash = reportHash(report);
  const begin = store.beginOrResume(hash, report.reportId, report.findings.length, owner);
  if (begin.type !== 'started') return { begin, issues };
  const catalog = new Map(defaultCatalog.map((r) => [r.ruleId, r]));
  let current = issues;
  let cursor = begin.session.cursor;
  while (cursor < report.findings.length) {
    const result = applyFinding(current, report.findings[cursor], {
      report,
      catalog,
      now: new Date(1_790_000_000_000 + cursor * 1000).toISOString()
    });
    current = result.issues;
    cursor += 1;
    if (cursor === failAt) {
      store.fail(hash, '模拟中断');
      return { begin: { type: 'failed' }, issues: current };
    }
    store.checkpoint(hash, cursor);
  }
  store.complete(hash);
  return { begin, issues: current };
}

describe('端到端：导入 → 对账 → 重算 → 关闭不翻旧账', () => {
  it('完整走一遍用户旅程', () => {
    const store = new ImportSessionStore(memoryStorage(), 'it-sessions');

    // 1) 首次导入：1 条关联人工问题，3 条新建，1 条报告内去重
    const first = runImport(store, sampleReport, [manualSeed], 'alice');
    expect(first.begin.type).toBe('started');
    expect(first.issues).toHaveLength(4);
    const linked = first.issues.find((i) => i.id === 'issue-1')!;
    expect(linked.sources.map((s) => s.kind)).toEqual(['manual', 'scan']);
    expect(linked.severity).toBe('serious'); // 人工定级不动
    expect(linked.status).toBe('triaged');

    // 2) 另一人同时导入同一份报告：duplicate，先到者生效
    const concurrent = runImport(store, sampleReport, first.issues, 'bob');
    expect(concurrent.begin.type).toBe('duplicate');
    expect(concurrent.issues).toHaveLength(4);

    // 3) 规则等级调整：color-contrast serious → critical，扫描建档的跟着重算
    const stricter = new Map(defaultCatalog.map((r) => [r.ruleId, { ...r }]));
    const entry = stricter.get('color-contrast')!;
    stricter.set('color-contrast', { ...entry, severity: 'critical', version: entry.version + 1 });
    const recomputed = recomputeWithCatalog(first.issues, stricter, '2026-10-08T00:00:00.000Z');
    expect(recomputed.recomputed).toBe(1);
    const contrast = recomputed.issues.find((i) => i.ruleId === 'color-contrast')!;
    expect(contrast.severity).toBe('critical');

    // 4) 关闭 label 问题后重新导入：已关闭不翻旧账
    const closed = recomputed.issues.map((i) => (i.ruleId === 'label' ? { ...i, status: 'closed' as const } : i));
    store.clear(reportHash(sampleReport)); // 模拟新一波扫描任务沿用同一报告内容
    const reimport = runImport(store, sampleReport, closed, 'alice');
    expect(reimport.issues).toHaveLength(4);
    const labelIssue = reimport.issues.find((i) => i.ruleId === 'label')!;
    expect(labelIssue.status).toBe('closed');
    expect(labelIssue.severity).toBe('critical'); // 未被重算翻案
  });

  it('中途失败后从断点继续，最终结果与一次跑完一致', () => {
    const storageA = memoryStorage();
    const storeA = new ImportSessionStore(storageA, 'it-sessions');
    const failed = runImport(storeA, sampleReport, [manualSeed], 'alice', 2);
    expect(failed.begin.type).toBe('failed');
    // 断点采用“先应用后落盘”的至少一次语义：第 2 条已应用但未落盘，续传会幂等地重放它
    expect(storeA.get(reportHash(sampleReport))?.cursor).toBe(1);
    const resumed = runImport(storeA, sampleReport, failed.issues, 'alice');
    expect(resumed.begin.type).toBe('started');
    if (resumed.begin.type === 'started') expect(resumed.begin.resumed).toBe(true);

    const storeB = new ImportSessionStore(memoryStorage(), 'it-sessions');
    const uninterrupted = runImport(storeB, sampleReport, [manualSeed], 'alice');

    const normalize = (issues: AuditIssue[]) =>
      issues.map((i) => ({
        ...i,
        id: '',
        updatedAt: '',
        sources: i.sources.map((s) => (s.kind === 'scan' ? { ...s, firstSeenAt: '', lastSeenAt: '' } : s))
      }));
    expect(normalize(resumed.issues)).toEqual(normalize(uninterrupted.issues));
  });

  it('指纹把页面写法差异归并到同一条', () => {
    const store = new ImportSessionStore(memoryStorage(), 'it-sessions');
    const variant: ScanReport = {
      ...sampleReport,
      reportId: 'scan-2026-10-08-checkout',
      findings: [{ page: ' /Checkout/#pay ', selector: '  .pay-button', ruleId: 'Color-Contrast', summary: '复扫仍命中' }]
    };
    const first = runImport(store, sampleReport, [manualSeed], 'alice');
    const second = runImport(store, variant, first.issues, 'alice');
    expect(second.issues).toHaveLength(4);
    const contrast = second.issues.find((i) => i.ruleId === 'color-contrast')!;
    expect(contrast.fingerprint).toBe(fingerprintOf('/checkout', '.pay-button', 'color-contrast'));
    expect(contrast.sources.filter((s) => s.kind === 'scan')).toHaveLength(2);
  });
});
