import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// 在导入模块前补一个 localStorage 垫片（Node 环境没有）。
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key)
};

const {
  findingKey,
  reportKey,
  reconcileReport,
  recomputeSeverities,
  migrateIssue,
  parseReport,
  parseRuleConfig,
  acquireLock,
  releaseLock,
  loadCheckpoint,
  latestCheckpoint,
  clearCheckpoint,
  DEFAULT_RULE_CONFIG,
  SAMPLE_REPORT
} = await import('./reconcile.generated.mjs');

before(() => {
  store.clear();
  clearCheckpoint();
});

const manualIssue = (overrides = {}) => ({
  id: 'm-1',
  title: '人工发现的焦点问题',
  flow: '/checkout',
  steps: '按 Esc 后焦点丢失',
  impactGroup: '键盘与读屏用户',
  severity: 'serious',
  status: 'triaged',
  fixNote: '',
  retestNote: '',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'manual',
  severityOverridden: true,
  ...overrides
});

test('findingKey 由页面、元素定位、规则编号组成并去空白', () => {
  assert.equal(findingKey({ page: '/a', locator: '#x', ruleId: 'r' }), '/a::#x::r');
  assert.equal(findingKey({ page: ' /a ', locator: ' #x ', ruleId: ' r ' }), '/a::#x::r');
  assert.notEqual(
    findingKey({ page: '/a', locator: '#x', ruleId: 'r1' }),
    findingKey({ page: '/a', locator: '#x', ruleId: 'r2' })
  );
});

test('reportKey：有编号用编号，无编号用配对指纹', () => {
  assert.equal(reportKey({ reportId: 'R1', findings: [] }), 'report:R1');
  const a = reportKey({ findings: [{ page: '/a', locator: '#x', ruleId: 'r' }] });
  const b = reportKey({ findings: [{ page: '/a', locator: '#x', ruleId: 'r' }] });
  const c = reportKey({ findings: [{ page: '/b', locator: '#x', ruleId: 'r' }] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('新报告：扫描发现创建为 scan 来源问题，严重程度取规则配置', async () => {
  const issues = [];
  const persist = (next) => { issues.length = 0; issues.push(...next); };
  const result = await reconcileReport(issues, SAMPLE_REPORT, DEFAULT_RULE_CONFIG, persist);
  assert.equal(result.created, 4);
  assert.equal(result.updated, 0);
  assert.equal(issues.length, 4);
  const contrast = issues.find((i) => i.ruleId === 'color-contrast');
  assert.equal(contrast.source, 'scan');
  assert.equal(contrast.severity, 'serious');
  assert.equal(contrast.status, 'open');
  assert.equal(contrast.severityOverridden, false);
  assert.ok(contrast.scanKey.includes('/checkout'));
});

test('重复导入同一份报告：只更新那一条，不产生重复', async () => {
  const issues = [];
  const persist = (next) => { issues.length = 0; issues.push(...next); };
  await reconcileReport(issues, SAMPLE_REPORT, DEFAULT_RULE_CONFIG, persist);
  const firstCount = issues.length;
  const firstId = issues[0].id;
  const result2 = await reconcileReport(issues, SAMPLE_REPORT, DEFAULT_RULE_CONFIG, persist);
  assert.equal(issues.length, firstCount);
  assert.equal(result2.created, 0);
  assert.equal(result2.updated, 4);
  assert.equal(issues[0].id, firstId);
});

test('与人工问题对上：来源记为 both，人工标题/步骤/严重程度/状态保留', async () => {
  const issues = [
    manualIssue({
      page: '/checkout',
      locator: '#pay-button',
      ruleId: 'color-contrast',
      scanKey: findingKey({ page: '/checkout', locator: '#pay-button', ruleId: 'color-contrast' })
    })
  ];
  const persist = (next) => { issues.length = 0; issues.push(...next); };
  const result = await reconcileReport(issues, SAMPLE_REPORT, DEFAULT_RULE_CONFIG, persist);
  assert.equal(result.matched, 1);
  assert.equal(result.created, 3);
  const matched = issues.find((i) => i.ruleId === 'color-contrast');
  assert.equal(matched.source, 'both');
  assert.equal(matched.title, '人工发现的焦点问题');
  assert.equal(matched.steps, '按 Esc 后焦点丢失');
  assert.equal(matched.severity, 'serious');
  assert.equal(matched.status, 'triaged');
  assert.equal(matched.scanMessage, '支付按钮对比度不足（2.9:1）');
});

test('人工严重程度优先：severityOverridden 的问题不被扫描等级改动', async () => {
  const issues = [
    manualIssue({
      page: '/checkout',
      locator: '#pay-button',
      ruleId: 'color-contrast',
      scanKey: findingKey({ page: '/checkout', locator: '#pay-button', ruleId: 'color-contrast' }),
      severity: 'critical'
    })
  ];
  const persist = (next) => { issues.length = 0; issues.push(...next); };
  await reconcileReport(issues, SAMPLE_REPORT, { ...DEFAULT_RULE_CONFIG, 'color-contrast': 'minor' }, persist);
  const matched = issues.find((i) => i.ruleId === 'color-contrast');
  assert.equal(matched.severity, 'critical');
  assert.equal(matched.scanSeverity, undefined);
});

test('已关闭的问题不翻旧账：跳过更新，也不重算', async () => {
  const issues = [
    manualIssue({
      page: '/checkout',
      locator: '#pay-button',
      ruleId: 'color-contrast',
      scanKey: findingKey({ page: '/checkout', locator: '#pay-button', ruleId: 'color-contrast' }),
      status: 'closed',
      severity: 'minor'
    })
  ];
  const persist = (next) => { issues.length = 0; issues.push(...next); };
  const result = await reconcileReport(issues, SAMPLE_REPORT, { ...DEFAULT_RULE_CONFIG, 'color-contrast': 'critical' }, persist);
  assert.equal(result.skippedClosed, 1);
  assert.equal(result.updated, 0);
  const closed = issues.find((i) => i.ruleId === 'color-contrast');
  assert.equal(closed.severity, 'minor');
  assert.equal(closed.status, 'closed');
});

test('扫描规则等级变化：未覆盖的扫描问题重算，人工覆盖与已关闭的不动', async () => {
  const issues = [
    manualIssue({ id: 'scan-1', source: 'scan', severityOverridden: false, severity: 'serious', ruleId: 'color-contrast', status: 'open' }),
    manualIssue({ id: 'scan-2', source: 'scan', severityOverridden: false, severity: 'serious', ruleId: 'image-alt', status: 'open' }),
    manualIssue({ id: 'man-1', severity: 'minor', ruleId: 'color-contrast', status: 'triaged' }),
    manualIssue({ id: 'clo-1', source: 'scan', severityOverridden: false, severity: 'serious', ruleId: 'color-contrast', status: 'closed' })
  ];
  const { issues: next, recomputed } = recomputeSeverities(issues, { 'color-contrast': 'moderate', 'image-alt': 'critical' });
  assert.equal(recomputed, 2);
  assert.equal(next.find((i) => i.id === 'scan-1').severity, 'moderate');
  assert.equal(next.find((i) => i.id === 'scan-2').severity, 'critical');
  assert.equal(next.find((i) => i.id === 'man-1').severity, 'minor');
  assert.equal(next.find((i) => i.id === 'clo-1').severity, 'serious');
});

test('并发导入：同一份报告只让先到的生效', async () => {
  store.clear();
  clearCheckpoint();
  const nonce = 'holder-nonce';
  assert.equal(acquireLock(reportKey(SAMPLE_REPORT), nonce), true);
  await assert.rejects(
    reconcileReport([], SAMPLE_REPORT, DEFAULT_RULE_CONFIG, () => {}),
    (error) => error.code === 'LOCK_HELD'
  );
  releaseLock(reportKey(SAMPLE_REPORT), nonce);
});

test('中途失败：检查点记录断点，继续导入不重复创建', async () => {
  store.clear();
  clearCheckpoint();
  const issues = [];
  const persist = (next) => { issues.length = 0; issues.push(...next); };
  const options = { batchSize: 1, failAfterBatches: 2 };
  await assert.rejects(
    reconcileReport(issues, SAMPLE_REPORT, DEFAULT_RULE_CONFIG, persist, options),
    (error) => error.code === 'SIMULATED_FAILURE'
  );
  const checkpoint = latestCheckpoint();
  assert.equal(checkpoint.status, 'failed');
  assert.equal(checkpoint.processed, 2);
  assert.equal(issues.length, 2);

  // 从断点继续：前 2 条不重复创建，后 2 条补齐。
  const result = await reconcileReport(issues, SAMPLE_REPORT, DEFAULT_RULE_CONFIG, persist, { batchSize: 1 });
  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);
  assert.equal(issues.length, 4);
  const done = loadCheckpoint(reportKey(SAMPLE_REPORT));
  assert.equal(done.status, 'completed');
  assert.equal(done.processed, 4);
});

test('换一份报告：检查点不混用', async () => {
  store.clear();
  clearCheckpoint();
  const issues = [];
  const persist = (next) => { issues.length = 0; issues.push(...next); };
  await reconcileReport(issues, SAMPLE_REPORT, DEFAULT_RULE_CONFIG, persist);
  const other = { reportId: 'scan-other', findings: [{ page: '/x', locator: '#y', ruleId: 'label', message: '缺少标签' }] };
  const result = await reconcileReport(issues, other, DEFAULT_RULE_CONFIG, persist);
  assert.equal(result.created, 1);
  assert.equal(issues.length, 5);
});

test('锁的获取与释放：同报告冲突，不同报告不冲突', () => {
  store.clear();
  assert.equal(acquireLock('report:A', 'nonce-1'), true);
  assert.equal(acquireLock('report:A', 'nonce-2'), false);
  assert.equal(acquireLock('report:B', 'nonce-3'), true);
  releaseLock('report:A', 'nonce-2');
  assert.equal(acquireLock('report:A', 'nonce-4'), true);
  releaseLock('report:A', 'nonce-4');
  releaseLock('report:B', 'nonce-3');
});

test('parseReport / parseRuleConfig 校验非法输入', () => {
  assert.throws(() => parseReport('{'), (e) => e.code === 'INVALID_REPORT');
  assert.throws(() => parseReport('{}'), (e) => e.code === 'INVALID_REPORT');
  assert.throws(() => parseReport(JSON.stringify({ findings: [{ page: '/a' }] })), (e) => e.code === 'INVALID_REPORT');
  assert.throws(() => parseRuleConfig('{"color-contrast":"fatal"}'), (e) => e.code === 'INVALID_REPORT');
  assert.deepEqual(parseRuleConfig('{"label":"moderate"}'), { label: 'moderate' });
});

test('migrateIssue：旧数据补人工来源标记', () => {
  const migrated = migrateIssue({ id: 'x', title: '旧问题', severity: 'minor' });
  assert.equal(migrated.source, 'manual');
  assert.equal(migrated.severityOverridden, true);
  assert.equal(migrated.status, 'open');
});
