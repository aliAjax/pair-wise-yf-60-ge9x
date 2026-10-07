import type { ScanReport } from './types';

/**
 * 页面归一化：URL 小写 origin、去 hash、去末尾斜杠；
 * 非 URL（路由或页面名）折叠空白并小写。
 */
export function normalizePage(page: string): string {
  const trimmed = page.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    return `${url.origin.toLowerCase()}${path}${url.search}`;
  } catch {
    const collapsed = trimmed.replace(/\s+/g, ' ').toLowerCase();
    const noHash = collapsed.split('#')[0];
    return noHash.replace(/\/+$/, '') || '/';
  }
}

/** 元素定位归一化：折叠连续空白、去首尾空格（选择器本身大小写敏感，保留） */
export function normalizeSelector(selector: string): string {
  return selector.trim().replace(/\s+/g, ' ');
}

/** 规则编号归一化：trim + 小写 */
export function normalizeRuleId(ruleId: string): string {
  return ruleId.trim().toLowerCase();
}

/** 对账指纹：同一页面、同一元素、同一规则视为同一条缺陷 */
export function fingerprintOf(page: string, selector: string, ruleId: string): string {
  return [normalizePage(page), normalizeSelector(selector), normalizeRuleId(ruleId)].join('::');
}

/**
 * 报告幂等键：由报告编号与归一化后的发现内容决定。
 * 两人同时导入同一份报告得到相同哈希，先到者生效。
 */
export function reportHash(report: ScanReport): string {
  const canonical = JSON.stringify({
    reportId: report.reportId.trim(),
    findings: report.findings.map((f) => [
      normalizePage(f.page),
      normalizeSelector(f.selector),
      normalizeRuleId(f.ruleId),
      f.summary.trim()
    ])
  });
  // FNV-1a 双种子 64 位哈希，演示级幂等键足够；生产可换 sha-256
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
