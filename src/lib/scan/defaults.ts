import type { RuleCatalogEntry, ScanReport } from './types';

const SEED_TIME = '2026-10-01T09:00:00.000Z';

/** 默认扫描规则目录：等级可调整，调整后 version 递增并触发结论重算 */
export const defaultCatalog: RuleCatalogEntry[] = [
  { ruleId: 'focus-order', title: '焦点顺序不合逻辑', wcag: 'WCAG 2.4.3', severity: 'serious', version: 1, updatedAt: SEED_TIME },
  { ruleId: 'color-contrast', title: '文本对比度不足', wcag: 'WCAG 1.4.3', severity: 'serious', version: 1, updatedAt: SEED_TIME },
  { ruleId: 'label', title: '表单控件缺少标签', wcag: 'WCAG 1.3.1', severity: 'critical', version: 1, updatedAt: SEED_TIME },
  { ruleId: 'button-name', title: '按钮无可访问名称', wcag: 'WCAG 4.1.2', severity: 'critical', version: 1, updatedAt: SEED_TIME },
  { ruleId: 'image-alt', title: '图片缺少替代文本', wcag: 'WCAG 1.1.1', severity: 'serious', version: 1, updatedAt: SEED_TIME },
  { ruleId: 'aria-required-attr', title: 'ARIA 角色缺少必需属性', wcag: 'WCAG 4.1.2', severity: 'moderate', version: 1, updatedAt: SEED_TIME }
];

/**
 * 示例扫描报告。第一条与种子问题 issue-1 的定位三要素一致，
 * 用于演示“扫描发现对上人工问题、双来源保留”；最后一条与其重复，
 * 用于演示同一报告内去重。
 */
export const sampleReport: ScanReport = {
  reportId: 'scan-2026-10-07-checkout',
  tool: 'axe-core 4.10',
  generatedAt: '2026-10-07T09:30:00.000Z',
  findings: [
    {
      page: '/checkout',
      selector: '#checkout-dialog',
      ruleId: 'focus-order',
      summary: '结算弹窗关闭后焦点未返回触发按钮',
      snippet: '<div id="checkout-dialog" role="dialog" aria-modal="true">…</div>'
    },
    {
      page: '/checkout',
      selector: '.pay-button',
      ruleId: 'color-contrast',
      summary: '支付按钮文字对比度 2.8:1，低于 4.5:1',
      snippet: '<button class="pay-button">立即支付</button>'
    },
    {
      page: '/account',
      selector: '#phone',
      ruleId: 'label',
      summary: '手机号输入框缺少可访问名称',
      snippet: '<input id="phone" type="tel">'
    },
    {
      page: '/account',
      selector: '.avatar-img',
      ruleId: 'image-alt',
      summary: '头像图片缺少 alt 替代文本',
      snippet: '<img class="avatar-img" src="/u/42.png">'
    },
    {
      page: '/checkout',
      selector: '#checkout-dialog',
      ruleId: 'focus-order',
      summary: '结算弹窗关闭后焦点未返回触发按钮（同页重复上报）',
      snippet: '<div id="checkout-dialog" role="dialog" aria-modal="true">…</div>'
    }
  ]
};
