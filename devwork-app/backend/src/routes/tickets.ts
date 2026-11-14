/**
 * ticket 路由：工单读面与三个动作（回答 / 停止 / 重派）。
 *
 * 执行入口不在这里：没有「跑一下」的端点，跑不跑由 Agent 循环按 stage 决定。
 * 「能手工触发执行」的接口，最后一定会被当成重试按钮按到库里长草。
 */
import type { Express, Request, Response } from 'express';
import { ApiFailure, identity, ok, queryString, wrap } from '../http/core';
import { parseBody } from '../http/validate';
import { ticketAnswerSchema } from '../../../shared/contracts';
import { writeAudit } from '../db/database';
import {
  answerAttention,
  dispatchQueued,
  getTicket,
  getTicketDetail,
  listTickets,
  listTicketsByConversation,
  retryTicket,
  stopTicket,
  ticketStats,
  waitingTickets,
} from '../services/tickets';
import { agentLoopStatus, agentLoopStep } from '../services/agent-loop';

export function registerTicketRoutes(app: Express): void {
  /* 固定路径必须先于 /:id 注册，否则 stats 会被当成工单 id。 */
  app.get('/api/tickets/stats', wrap(async (_req: Request, res: Response) => {
    ok(res, { ...ticketStats(), loop: agentLoopStatus() });
  }));

  /* 「谁在等我」：侧栏徽标与会话 tab 橙点共用这一份事实。
   * 与 stats 分开的理由是它要带明细（哪条会话、等多久、等我干什么），
   * 只在有人真要看的时候才值得多查这几次 join。 */
  app.get('/api/tickets/waiting', wrap(async (req: Request, res: Response) => {
    const limit = Number(queryString(req, 'limit', '20')) || 20;
    const items = waitingTickets(limit);
    /* 按阶段分桶一并给：徽标的 hover 要能说清「2 个等你回答、1 个待验收」，
     * 让前端再数一遍等于把同一份事实算两次。 */
    const byStage: Record<string, number> = {};
    items.forEach((item) => {
      const stage = String(item.stage);
      byStage[stage] = (byStage[stage] ?? 0) + 1;
    });
    ok(res, { items, total: items.length, byStage });
  }));

  /** 手动推一轮循环：面板的「立即推进」与测试都靠它，避免等 1s 定时器。 */
  app.post('/api/tickets/step', wrap(async (_req: Request, res: Response) => {
    ok(res, await agentLoopStep());
  }));

  app.get('/api/tickets', wrap(async (req: Request, res: Response) => {
    const limit = Number(queryString(req, 'limit', '30')) || 30;
    ok(res, listTickets({
      limit,
      stage: queryString(req, 'stage', ''),
      state: queryString(req, 'state', ''),
    }));
  }));

  /* 详情：一张单的全部事实（授权范围 / 派工轮次 / 提问历史 / 收件箱）。
   * 人来判断「这张单跑得对不对」靠的是这些，不是会话里的工具调用流水。 */
  app.get('/api/tickets/:id', wrap(async (req: Request, res: Response) => {
    const ticket = getTicketDetail(String(req.params.id));
    if (!ticket) throw new ApiFailure('E_NOT_FOUND', `工单不存在：${req.params.id}`);
    ok(res, ticket);
  }));

  /* 按会话反查工单：协作流视图（会话 ↔ 工单 ↔ 轮次）的唯一数据入口。
   * 路径挂在 conversations 下而不是 tickets?conversationId=，
   * 是因为「这条会话后来被谁接走了」的主语是会话，不是工单列表。 */
  app.get('/api/conversations/:id/tickets', wrap(async (req: Request, res: Response) => {
    const limit = Number(queryString(req, 'limit', '20')) || 20;
    const items = listTicketsByConversation(String(req.params.id), limit);
    ok(res, { items, total: items.length });
  }));

  app.post('/api/tickets/:id/answer', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(ticketAnswerSchema, req);
    const result = answerAttention(String(req.params.id), payload.attentionId, payload.answer);
    if (!result.ok) throw new ApiFailure('E_VALIDATION', result.message);
    writeAudit({
      /* 归属从工单推导：工单属于某个工作区，审计不该挂在默认值上。 */
      workspaceId: String(getTicket(String(req.params.id))?.workspaceId ?? ''),
      actor: identity(req).name, source: 'user',
      action: 'ticket.answer', target: `ticket:${String(req.params.id)}`,
      result: '成功', severity: 'info', detail: payload.answer.slice(0, 200),
    });
    ok(res, { message: result.message, ticket: getTicket(String(req.params.id)) });
  }));

  app.post('/api/tickets/:id/stop', wrap(async (req: Request, res: Response) => {
    const done = stopTicket(String(req.params.id));
    if (!done) throw new ApiFailure('E_ALREADY_RESOLVED', '工单不存在或已结束');
    ok(res, { ticket: getTicket(String(req.params.id)) });
  }));

  app.post('/api/tickets/:id/retry', wrap(async (req: Request, res: Response) => {
    const result = retryTicket(String(req.params.id));
    if (!result.ok) throw new ApiFailure('E_VALIDATION', result.message);
    ok(res, { message: result.message, ticket: getTicket(String(req.params.id)) });
  }));

  /** 手工推一次派工（排队的工单立刻起跑），不影响循环本身。 */
  app.post('/api/tickets/dispatch', wrap(async (_req: Request, res: Response) => {
    ok(res, { dispatched: dispatchQueued() });
  }));
}
