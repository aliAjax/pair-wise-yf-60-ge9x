import { z } from 'zod';

export const findingSchema = z.object({
  page: z.string().min(1, '发现缺少页面'),
  selector: z.string().min(1, '发现缺少元素定位'),
  ruleId: z.string().min(1, '发现缺少规则编号'),
  summary: z.string().default(''),
  snippet: z.string().optional()
});

export const reportSchema = z.object({
  reportId: z.string().min(1, '报告缺少 reportId'),
  tool: z.string().min(1, '报告缺少 tool'),
  generatedAt: z.string().min(1, '报告缺少 generatedAt'),
  findings: z.array(findingSchema).min(1, '报告至少包含一条发现')
});
