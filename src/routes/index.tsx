import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  DEFAULT_RULE_CONFIG,
  SAMPLE_REPORT,
  findingKey,
  latestCheckpoint,
  currentLock,
  migrateIssue,
  parseReport,
  parseRuleConfig,
  recomputeSeverities,
  reconcileReport,
  ImportError,
  type AuditIssue,
  type IssueStatus,
  type ReconcileResult,
  type RuleConfig,
  type Severity
} from '../lib/reconcile';

const severityLabel: Record<Severity, string> = { critical: '阻断', serious: '严重', moderate: '中等', minor: '轻微' };
const statusLabel: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '已重新打开'
};
const sourceLabel = { manual: '人工', scan: '扫描', both: '两边' } as const;

interface WorkbenchState { issues: AuditIssue[]; events: AuditEvent[] }
interface AuditEvent { id: string; at: string; issueId: string | null; message: string }

const seed: WorkbenchState = {
  issues: [
    {
      id: 'issue-1',
      title: '结算弹窗关闭后焦点丢失',
      flow: '订单结算',
      steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
      impactGroup: '键盘与读屏用户',
      severity: 'serious',
      status: 'triaged',
      fixNote: '',
      retestNote: '',
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      source: 'manual',
      severityOverridden: true
    },
    {
      id: 'issue-2',
      title: '错误提示未与输入框关联',
      flow: '账户设置',
      steps: '输入无效手机号后使用读屏读取输入框',
      impactGroup: '读屏用户',
      severity: 'moderate',
      status: 'fixing',
      fixNote: '已增加 aria-describedby，等待构建',
      retestNote: '',
      updatedAt: new Date(Date.now() - 7200_000).toISOString(),
      source: 'manual',
      severityOverridden: true
    }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
  ]
};

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
  page: z.string().optional(),
  locator: z.string().optional(),
  ruleId: z.string().optional()
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = JSON.parse(localStorage.getItem('a11y-audit-v1') ?? 'null') as WorkbenchState | null;
    if (!raw) return seed;
    return { issues: (raw.issues ?? []).map(migrateIssue), events: raw.events ?? [] };
  } catch {
    return seed;
  }
}

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious', page: '', locator: '', ruleId: '' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-v1', JSON.stringify(state));
  });

  const addEvent = (issueId: string | null, message: string) =>
    setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message }, ...events]);

  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string) => {
    setState('issues', (issue) => issue.id === id, produce((issue) => Object.assign(issue, patch, { updatedAt: new Date().toISOString() })));
    addEvent(id, message);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const identity =
      values.page?.trim() && values.locator?.trim() && values.ruleId?.trim()
        ? {
            page: values.page.trim(),
            locator: values.locator.trim(),
            ruleId: values.ruleId.trim(),
            scanKey: findingKey({ page: values.page.trim(), locator: values.locator.trim(), ruleId: values.ruleId.trim() })
          }
        : {};
    const existing = identity.scanKey ? state.issues.find((issue) => issue.scanKey === identity.scanKey) : undefined;
    if (existing) {
      // 与已有扫描记录对上：并入同一条，两边来源都留着，不重复记。
      updateIssue(
        existing.id,
        {
          title: values.title,
          flow: values.flow,
          steps: values.steps,
          impactGroup: values.impactGroup,
          severity: values.severity,
          source: existing.source === 'scan' ? 'both' : existing.source,
          severityOverridden: true,
          ...identity
        },
        '人工问题与扫描记录配对，两边来源都保留'
      );
      setSelectedId(existing.id);
      return;
    }
    const issue: AuditIssue = {
      id: crypto.randomUUID(),
      title: values.title,
      flow: values.flow,
      steps: values.steps,
      impactGroup: values.impactGroup,
      severity: values.severity,
      status: 'open',
      fixNote: '',
      retestNote: '',
      updatedAt: new Date().toISOString(),
      source: 'manual',
      severityOverridden: true,
      ...identity
    };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    updateIssue(duplicate.id, { canonicalId: canonical.id }, `重复问题已合并到 ${canonical.title}`);
    setSelectedId(canonical.id);
  };

  // ---- 扫描报告对账 ----
  const [reportText, setReportText] = createSignal(JSON.stringify(SAMPLE_REPORT, null, 2));
  const [ruleConfigText, setRuleConfigText] = createSignal(JSON.stringify(DEFAULT_RULE_CONFIG, null, 2));
  const [importStatus, setImportStatus] = createSignal<'idle' | 'running' | 'done' | 'failed' | 'locked'>('idle');
  const [importError, setImportError] = createSignal('');
  const [lastResult, setLastResult] = createSignal<ReconcileResult | null>(null);
  const [simulateFailure, setSimulateFailure] = createSignal(false);
  const [checkpoint, setCheckpoint] = createSignal(latestCheckpoint());
  const [lockInfo, setLockInfo] = createSignal(currentLock());

  const applyIssues = (next: AuditIssue[]) => {
    setState('issues', next);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const runImport = async () => {
    let report;
    let ruleConfig: RuleConfig;
    try {
      report = parseReport(reportText());
      ruleConfig = parseRuleConfig(ruleConfigText());
    } catch (error) {
      setImportStatus('failed');
      setImportError((error as Error).message);
      return;
    }
    setImportStatus('running');
    setImportError('');
    try {
      const result = await reconcileReport(
        state.issues,
        report,
        ruleConfig,
        applyIssues,
        { batchSize: 1, failAfterBatches: simulateFailure() ? 2 : undefined }
      );
      setLastResult(result);
      setImportStatus('done');
      addEvent(null, `扫描报告对账完成：新增 ${result.created} 条，更新 ${result.updated} 条，匹配人工 ${result.matched} 条，跳过已关闭 ${result.skippedClosed} 条`);
    } catch (error) {
      if (error instanceof ImportError && error.code === 'LOCK_HELD') {
        setImportStatus('locked');
      } else {
        setImportStatus('failed');
      }
      setImportError((error as Error).message);
    } finally {
      setCheckpoint(latestCheckpoint());
      setLockInfo(currentLock());
    }
  };

  const runRecompute = () => {
    let ruleConfig: RuleConfig;
    try {
      ruleConfig = parseRuleConfig(ruleConfigText());
    } catch (error) {
      setImportStatus('failed');
      setImportError((error as Error).message);
      return;
    }
    const { issues: next, recomputed } = recomputeSeverities(state.issues, ruleConfig);
    applyIssues(next);
    setImportStatus('done');
    setLastResult(null);
    addEvent(null, `扫描规则等级重算完成：${recomputed} 条问题的严重程度已按新规则更新`);
  };

  const discardCheckpoint = () => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem('a11y-scan-checkpoint-v1');
    setCheckpoint(null);
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
          <div class="card"><span>扫描来源</span><strong>{state.issues.filter((issue) => issue.source === 'scan' || issue.source === 'both').length}</strong></div>
        </section>

        <section class="card" aria-labelledby="reconcile-title" style="margin-bottom:18px">
          <h2 id="reconcile-title">扫描报告对账</h2>
          <p>扫描发现按页面、元素定位、规则编号配对；重复导入只更新同一条，与人工问题对上后两边来源都保留；人工严重程度与状态优先；已关闭的不翻旧账。</p>
          <Show when={lockInfo()}>
            <p role="alert" class="error">同一份报告正在导入中（先到的导入生效），请等待当前导入完成。</p>
          </Show>
          <Show when={checkpoint() && (checkpoint()!.status === 'in-progress' || checkpoint()!.status === 'failed')}>
            <p role="status" class="badge" style="display:block;margin:8px 0">
              存在未完成的导入检查点：已处理 {checkpoint()!.processed}/{checkpoint()!.total} 条{checkpoint()!.error ? `（${checkpoint()!.error}）` : ''}，可从断点继续。
              <button style="margin-left:8px" onClick={runImport} disabled={importStatus() === 'running'}>继续导入</button>
              <button class="secondary" style="margin-left:4px" onClick={discardCheckpoint}>放弃检查点</button>
            </p>
          </Show>
          <div class="grid" style="margin-top:8px">
            <label>扫描报告（JSON）
              <textarea rows={10} value={reportText()} onInput={(event) => setReportText(event.currentTarget.value)} spellcheck={false} />
            </label>
            <label>规则等级配置（规则编号 → 严重程度）
              <textarea rows={10} value={ruleConfigText()} onInput={(event) => setRuleConfigText(event.currentTarget.value)} spellcheck={false} />
            </label>
          </div>
          <div role="group" aria-label="对账操作" style="margin-top:8px">
            <button onClick={runImport} disabled={importStatus() === 'running'}>{importStatus() === 'running' ? '导入中…' : '导入对账'}</button>
            <button class="secondary" onClick={() => setReportText(JSON.stringify(SAMPLE_REPORT, null, 2))}>填入示例报告</button>
            <button class="secondary" onClick={runRecompute} disabled={importStatus() === 'running'}>按规则重算等级</button>
            <label style="display:inline-flex;align-items:center;gap:4px;margin-left:8px">
              <input type="checkbox" checked={simulateFailure()} onChange={(event) => setSimulateFailure(event.currentTarget.checked)} />
              模拟中途失败（第 2 批后中断）
            </label>
          </div>
          <Show when={importStatus() === 'done' && lastResult()}>
            <p role="status" style="margin-top:8px">
              对账完成：新增 {lastResult()!.created} 条，更新 {lastResult()!.updated} 条，匹配人工 {lastResult()!.matched} 条，跳过已关闭 {lastResult()!.skippedClosed} 条，重算严重程度 {lastResult()!.recomputed} 条。
            </p>
          </Show>
          <Show when={importStatus() === 'failed'}>
            <p role="alert" class="error" style="margin-top:8px">导入失败：{importError()}。修复后重新导入即可从断点继续。</p>
          </Show>
          <Show when={importStatus() === 'locked'}>
            <p role="alert" class="error" style="margin-top:8px">同一份报告已有导入在执行，先到的导入生效，请稍后再试。</p>
          </Show>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{statusLabel[issue.status]}</span>
                  <span class="badge">{severityLabel[issue.severity]}</span>
                  <span class="badge">{sourceLabel[issue.source]}</span>
                  <span>{issue.flow}</span>
                  <span>{issue.impactGroup}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <Show when={issue.source !== 'manual' && issue.scanMessage}>
                  <p><strong>扫描证据：</strong>{issue.scanMessage}（{issue.ruleId} @ {issue.page} {issue.locator}）</p>
                </Show>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                <label>严重程度（人工优先，扫描不得覆盖）
                  <select
                    value={issue.severity}
                    onChange={(event) => updateIssue(issue.id, { severity: event.currentTarget.value as Severity, severityOverridden: true }, '人工调整严重程度，扫描结论让行')}
                  >
                    <option value="critical">阻断</option>
                    <option value="serious">严重</option>
                    <option value="moderate">中等</option>
                    <option value="minor">轻微</option>
                  </select>
                </label>
                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => updateIssue(issue.id, { status: 'triaged' }, '审核员完成分诊')}>确认问题</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'verifying' }, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>复测通过</button>{' '}
                  <button class="danger" onClick={() => updateIssue(issue.id, { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>复测失败</button>
                </div>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{(field, fieldProps) => <label>问题标题<input id="issue-title" {...fieldProps} value={field.value ?? ''} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label>}</AuditField>
              <AuditField name="flow">{(field, fieldProps) => <label>业务流程<input {...fieldProps} value={field.value ?? ''} /></label>}</AuditField>
              <AuditField name="steps">{(field, fieldProps) => <label>复现步骤<textarea {...fieldProps} rows={4} value={field.value ?? ''} /></label>}</AuditField>
              <AuditField name="impactGroup">{(field, fieldProps) => <label>影响人群<select {...fieldProps} value={field.value ?? ''}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>}</AuditField>
              <AuditField name="severity">{(field, fieldProps) => <label>严重程度<select {...fieldProps} value={field.value ?? ''}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>}</AuditField>
              <AuditField name="page">{(field, fieldProps) => <label>页面（可选，用于扫描配对）<input {...fieldProps} value={field.value ?? ''} placeholder="/checkout" /></label>}</AuditField>
              <AuditField name="locator">{(field, fieldProps) => <label>元素定位（可选，用于扫描配对）<input {...fieldProps} value={field.value ?? ''} placeholder="#pay-button" /></label>}</AuditField>
              <AuditField name="ruleId">{(field, fieldProps) => <label>规则编号（可选，用于扫描配对）<input {...fieldProps} value={field.value ?? ''} placeholder="color-contrast" /></label>}</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
