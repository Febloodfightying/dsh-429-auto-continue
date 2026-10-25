/**
 * dsh-429-auto-continue — host half.
 *
 * 429 兜底：回合以 429 / 限流 / 配额耗尽失败结束时，等待 delayMs 后自动向
 * 同一会话发送 message（等效手动输入），任务自动接着跑。定位是内置重试链
 * 之后的最后一道网：重试进行中不会打扰；用户手动继续或新回合开始会取消定时。
 *
 * 安全阀：同一会话连续自动继续达到 maxContinues 次后停手，避免 429 反复
 * 触发时无限循环消耗配额（0 = 不限次）。
 *
 * 热更新：设置界面保存后 dsh 走 volatile 热更新（updateVolatile 写回 fiber
 * config 里的 ref），不会重跑 apply。因此这里持有 volatile ref 并在每次
 * 使用时动态解包，保证保存立即生效、无需重启。
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
  const maxRaw = Number(unwrap(raw.maxContinues));
  return {
    enable: unwrap(raw.enable) !== false,
    delayMs: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 3_600_000) : 10_000,
    message: typeof unwrap(raw.message) === "string" && unwrap(raw.message).trim() !== ""
      ? unwrap(raw.message)
      : "继续任务",
    // 空数组尊重用户清空（此时只有 status===429 触发）。
    codes: codes.length === 0 && Array.isArray(codesRaw) ? [] : codes,
    excludeSubagents: unwrap(raw.excludeSubagents) !== false,
    maxContinues: Number.isFinite(maxRaw) ? Math.max(0, Math.min(100, maxRaw)) : 3
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
  // config 参数持有 fiber 的 volatile 引用：设置界面保存后 dsh 走 volatile
  // 热更新（updateVolatile 写回 ref），不会重跑 apply，所以这里每次使用时
  // 动态解包，保证保存立即生效。
  const rawConfig = config;
  const readCfg = () => normalizeConfig(rawConfig);

  if (readCfg().enable === false) {
    ctx.logger.info("[" + name + "] disabled via settings (enable=false)");
    return;
  }

  /** sessionId -> { timer, count }：每会话一个待发定时器 + 连续继续计数。 */
  const pending = new Map();

  /** 动态读取当前配置：volatile 热更新后能拿到新值。 */
  const current = () => readCfg();

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
      const c = current();
      await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: c.message }]
        },
        new AbortController().signal
      );
      ctx.logger.info("[" + name + "] 429 fallback: sent " + JSON.stringify(c.message) + " to " + sessionId);
    } catch (error) {
      ctx.logger.warn("[" + name + "] failed to send to " + sessionId + ": " + String(error?.message ?? error));
    }
  };

  /** 动态停用标志：enable 在运行中被关闭时立即停手。 */
  let disabled = false;

  const onSessionEvent = (session, event) => {
    if (disabled || !session || typeof session !== "object") return;
    const c = current();
    if (!c.enable) {
      // 总开关在运行中被关闭：清掉所有定时器并停用监听。
      disabled = true;
      for (const sessionId of [...pending.keys()]) clearPending(sessionId);
      ctx.logger.info("[" + name + "] disabled via settings (enable=false); auto-continue stopped");
      return;
    }
    if (c.excludeSubagents && (session.header?.origin === "subagent" || session.header?.parentSession)) return;
    const sessionId = session.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;

    if (event?.type === "turn/end") {
      const reason = event.data?.reason;
      if (!reason || reason.kind !== "error") return;
      if (!isTrigger(reason.error, c.codes)) return;
      // 连续继续次数上限：超过后停手，避免死循环。
      const previous = pending.get(sessionId);
      const count = (previous?.count ?? 0) + 1;
      if (c.maxContinues > 0 && count > c.maxContinues) {
        ctx.logger.warn("[" + name + "] reached maxContinues=" + c.maxContinues + " for " + sessionId + "; stopping");
        return;
      }
      clearPending(sessionId);
      const timer = setTimeout(() => {
        void sendContinue(sessionId).catch((error) => {
          try {
            ctx.logger.warn("[" + name + "] auto-continue failed: " + String(error?.message ?? error));
          } catch { /* ignore */ }
        });
      }, c.delayMs);
      pending.set(sessionId, { timer, cancelled: false, count });
      ctx.logger.info(
        "[" + name + "] 429 detected on " + sessionId + " (count=" + count + "); will send in " + c.delayMs + "ms"
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
