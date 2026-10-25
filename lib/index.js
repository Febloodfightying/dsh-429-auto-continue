/**
 * dsh-429-auto-continue — host half.
 *
 * 429 兜底：回合以 429 / 限流 / 配额耗尽失败结束时，等待 delayMs 后自动向
 * 同一会话发送 message（等效手动输入），任务自动接着跑。定位是内置重试链
 * 之后的最后一道网：重试进行中不会打扰；用户手动继续或新回合开始会取消定时。
 *
 * 安全阀：同一会话连续自动继续达到 maxContinues 次后停手，避免 429 反复
 * 触发时无限循环消耗配额（0 = 不限次）。
 */
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";

/** 插件身份，与 cordis.patch.yml roster 行 id 对应。 */
export const name = "429-auto-continue";

/** Config schema：导出后 dsh-settings 自动生成设置表单（可编辑，写入 cordis.patch.yml）。 */
export const Config = z.object({
  /** 总开关：false 时完全不监听、不发送。 */
  enable: z.boolean().default(true).volatile(),
  /** 429 后等待多少毫秒再自动发送。 */
  delayMs: z.number().min(0).max(3_600_000).default(10_000).volatile(),
  /** 自动发送的文本。 */
  message: z.string().default("继续任务").volatile(),
  /** 触发错误码白名单（大写；status===429 始终触发，与白名单无关）。 */
  codes: z.array(z.string()).default(["RATE_LIMIT", "QUOTA"]).volatile(),
  /** 是否排除子会话（subagent）。 */
  excludeSubagents: z.boolean().default(true).volatile(),
  /** 同一会话连续自动继续的次数上限（0 = 不限）。 */
  maxContinues: z.number().min(0).max(100).default(3).volatile(),
}).default({});

/** 解包 schemastery volatile 包装（cordis resolveConfig 后的字段带 .get()）。 */
function unwrap(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function"
    ? value.get()
    : value;
}

/** 归一化配置：任意输入都产出完整、合法的配置对象。 */
function normalizeConfig(config) {
  const raw = config ?? {};
  const delay = Number(unwrap(raw.delayMs));
  const codesRaw = unwrap(raw.codes);
  const codes = Array.isArray(codesRaw)
    ? codesRaw.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
    : ["RATE_LIMIT", "QUOTA"];
  return {
    enable: unwrap(raw.enable) !== false,
    delayMs: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 3_600_000) : 10_000,
    message: typeof unwrap(raw.message) === "string" && unwrap(raw.message).trim() !== ""
      ? unwrap(raw.message)
      : "继续任务",
    // 空数组尊重用户清空（此时只有 status===429 触发）。
    codes: codes.length === 0 && Array.isArray(codesRaw) ? [] : codes,
    excludeSubagents: unwrap(raw.excludeSubagents) !== false,
    maxContinues: Number.isFinite(Number(unwrap(raw.maxContinues)))
      ? Math.max(0, Math.min(100, Number(unwrap(raw.maxContinues))))
      : 3
  };
}

/** 429 类失败：status===429 或错误码在白名单。 */
function isTrigger(failure, codes) {
  if (!failure || typeof failure !== "object") return false;
  if (failure.status === 429) return true;
  const code = typeof failure.code === "string" ? failure.code.toUpperCase() : "";
  return code.length > 0 && codes.includes(code);
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  if (cfg.enable === false) {
    ctx.logger.info("[" + name + "] disabled via settings (enable=false)");
    return;
  }

  /** sessionId -> { timer, count }：每会话一个待发定时器 + 连续继续计数。 */
  const pending = new Map();

  const clearPending = (sessionId) => {
    const entry = pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(sessionId);
    entry.cancelled = true;
  };

  /** 取 sessionController（未声明 inject，用 ctx.get(name,false) 免注入读取）。 */
  const resolveController = () => {
    try {
      const byName = ctx.get("sessionController", false);
      if (byName && typeof byName.prompt === "function") return byName;
    } catch { /* fallthrough */ }
    try {
      const direct = ctx.sessionController;
      if (direct && typeof direct.prompt === "function") return direct;
    } catch { /* not injected */ }
    return undefined;
  };

  const sendContinue = async (sessionId) => {
    const entry = pending.get(sessionId);
    if (!entry || entry.cancelled) return;
    pending.delete(sessionId);

    const controller = resolveController();
    if (!controller) {
      ctx.logger.warn("[" + name + "] sessionController unavailable; cannot auto-send to " + sessionId);
      return;
    }
    try {
      await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: cfg.message }]
        },
        new AbortController().signal
      );
      ctx.logger.info("[" + name + "] 429 fallback: sent " + JSON.stringify(cfg.message) + " to " + sessionId);
    } catch (error) {
      ctx.logger.warn("[" + name + "] failed to send to " + sessionId + ": " + String(error?.message ?? error));
    }
  };

  const onSessionEvent = (session, event) => {
    if (!session || typeof session !== "object") return;
    if (cfg.excludeSubagents && (session.header?.origin === "subagent" || session.header?.parentSession)) return;
    const sessionId = session.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;

    if (event?.type === "turn/end") {
      const reason = event.data?.reason;
      if (!reason || reason.kind !== "error") return;
      if (!isTrigger(reason.error, cfg.codes)) return;
      // 连续继续次数上限：超过后停手，避免死循环。
      const previous = pending.get(sessionId);
      const count = (previous?.count ?? 0) + 1;
      if (cfg.maxContinues > 0 && count > cfg.maxContinues) {
        ctx.logger.warn("[" + name + "] reached maxContinues=" + cfg.maxContinues + " for " + sessionId + "; stopping");
        return;
      }
      clearPending(sessionId);
      const timer = setTimeout(() => {
        void sendContinue(sessionId).catch((error) => {
          try {
            ctx.logger.warn("[" + name + "] auto-continue failed: " + String(error?.message ?? error));
          } catch { /* ignore */ }
        });
      }, cfg.delayMs);
      pending.set(sessionId, { timer, cancelled: false, count });
      ctx.logger.info(
        "[" + name + "] 429 detected on " + sessionId + " (count=" + count + "); will send in " + cfg.delayMs + "ms"
      );
      return;
    }

    // 用户手动继续 / 新回合开始：取消待发定时器。
    if (pending.has(sessionId) && event?.type === "turn/start") {
      clearPending(sessionId);
      return;
    }
    if (
      pending.has(sessionId) &&
      event?.type === "user/message" &&
      (event.surfaceOp === "append" || event.data?.surfaceOp === "append")
    ) {
      clearPending(sessionId);
    }
  };

  const listener = (session, event) => {
    try {
      onSessionEvent(session, event);
    } catch { /* never break host dispatch */ }
  };

  const disposeListener = ctx.on("session/event", listener);
  ctx.effect(() => () => {
    disposeListener();
    for (const sessionId of [...pending.keys()]) clearPending(sessionId);
  }, name + ": dispose timers");
}
