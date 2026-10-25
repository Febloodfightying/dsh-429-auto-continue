/**
 * dsh-429-auto-continue — browser half.
 *
 * 注册总设置界面的 settings.section 入口（"429 自动继续"），
 * 提供 5 个可编辑配置（总开关/延迟/消息/错误码/排除子会话/继续次数上限），
 * 编辑只在本地草稿，点「保存」一次性写入。
 */
window.__ModuleLoader__.load({
  id: "dsh-429-auto-continue",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var react_jsx_runtime = require("react/jsx-runtime");

    /** Locale namespace. */
    const NS = "429-auto-continue";

    const zh = {
      title: "429 自动继续设置",
      intro: "回合因 429 / 限流 / 配额耗尽失败后，自动向会话发送「继续任务」。",
      enabled: "启用",
      enabledHint: "关闭后本插件完全不监听、不发送。",
      on: "开",
      off: "关",
      delayMs: "延迟（毫秒）",
      delayMsHint: "429 失败后等待多少毫秒再自动发送。",
      message: "发送内容",
      messageHint: "自动发送的文本，等效于手动输入。",
      codes: "触发错误码",
      codesHint: "逗号分隔的错误码白名单；HTTP 429 始终触发，与白名单无关。留空则只认 429。",
      excludeSubagents: "排除子会话",
      excludeSubagentsHint: "不为后台子任务自动发送。",
      maxContinues: "连续继续次数上限",
      maxContinuesHint: "同一会话连续自动继续达到此数后停手（0 = 不限）。防止 429 死循环。",
      saved: "已保存",
      saveError: "保存失败",
      save: "保存",
      unavailable: "配置暂不可用（插件未加载）。"
    };

    const en = {
      title: "429 Auto-Continue Settings",
      intro: "When a turn dies from 429 / rate-limit / quota, automatically send a continue message.",
      enabled: "Enabled",
      enabledHint: "When off the plugin never listens or sends.",
      on: "On",
      off: "Off",
      delayMs: "Delay (ms)",
      delayMsHint: "Milliseconds to wait before auto-sending after a 429 failure.",
      message: "Message",
      messageHint: "Text to auto-send, equivalent to typing it yourself.",
      codes: "Trigger codes",
      codesHint: "Comma-separated error-code allowlist; HTTP 429 always triggers regardless. Leave empty to only match 429.",
      excludeSubagents: "Exclude subagents",
      excludeSubagentsHint: "Do not auto-send for background subtasks.",
      maxContinues: "Max consecutive continues",
      maxContinuesHint: "Stop after this many auto-continues per session (0 = unlimited). Prevents a 429 loop.",
      saved: "Saved",
      saveError: "Save failed",
      save: "Save",
      unavailable: "Settings unavailable (plugin not loaded)."
    };

    /**
     * Resolve the 429-auto-continue entry form from ctx.configForms.
     * Returns undefined while the entry is not (yet) served.
     */
    function resolveForm(ctx) {
      try {
        const served = ctx.configForms.describe().getSnapshot().view?.namespaces.map((row) => row.ns);
        if (Array.isArray(served) && served.includes("429-auto-continue")) {
          return ctx.configForms.get("429-auto-continue");
        }
      } catch {
        /* not ready yet */
      }
      return void 0;
    }

    /** One labelled control row. */
    function Row({ label, hint, children }) {
      return react_jsx_runtime.jsxs("div", {
        style: { marginBottom: 14 },
        children: [
          react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 4 }, children: label }),
          children,
          hint ? react_jsx_runtime.jsx("div", { style: { color: "#8a8a8a", fontSize: 12, marginTop: 4 }, children: hint }) : null
        ]
      });
    }

    function Toggle({ checked, onChange, onLabel, offLabel }) {
      return react_jsx_runtime.jsx("button", {
        type: "button",
        onClick: () => onChange(!checked),
        style: {
          padding: "4px 10px",
          borderRadius: 999,
          border: "1px solid #4a4a4a",
          background: checked ? "#1a73e8" : "transparent",
          color: checked ? "#ffffff" : "#e0e0e0",
          cursor: "pointer",
          fontSize: 13
        },
        children: checked ? onLabel : offLabel
      });
    }

    function AutoContinuePanel(props) {
      const { t, form } = props;
      const [snapshot, setSnapshot] = react.useState(() => (form ? form.getSnapshot() : { status: "loading" }));
      // 草稿：数字/文本字段用普通值；codes 单独用字符串（避免输入时光标跳动）。
      const [draft, setDraft] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [feedback, setFeedback] = react.useState("");

      react.useEffect(() => {
        if (!form) return void 0;
        const sync = () => {
          const snap = form.getSnapshot();
          setSnapshot(snap);
          if (snap.status === "ready") {
            const v = snap.value ?? {};
            setDraft((current) => current ?? {
              enable: v.enable !== false,
              delayMs: typeof v.delayMs === "number" ? v.delayMs : 10000,
              message: typeof v.message === "string" ? v.message : "继续任务",
              codesText: Array.isArray(v.codes) ? v.codes.join(", ") : "",
              excludeSubagents: v.excludeSubagents !== false,
              maxContinues: typeof v.maxContinues === "number" ? v.maxContinues : 3
            });
          }
        };
        sync();
        return form.subscribe(sync);
      }, [form]);

      if (!form || snapshot.status !== "ready" || draft === null) {
        return react_jsx_runtime.jsx("p", { style: { fontSize: 13 }, children: t("unavailable") });
      }

      const writable = snapshot.writable !== false;

      const setField = (field, next) => {
        setDraft((previous) => ({ ...previous, [field]: next }));
        setFeedback("");
      };

      const saveAll = async () => {
        setBusy(true);
        setFeedback("");
        try {
          const codes = draft.codesText.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
          const ops = [
            { op: "set", path: ["enable"], value: draft.enable },
            { op: "set", path: ["delayMs"], value: draft.delayMs },
            { op: "set", path: ["message"], value: draft.message },
            { op: "set", path: ["codes"], value: codes },
            { op: "set", path: ["excludeSubagents"], value: draft.excludeSubagents },
            { op: "set", path: ["maxContinues"], value: draft.maxContinues }
          ];
          const ok = await form.mutate(ops, snapshot.revision);
          if (ok) {
            setFeedback(t("saved"));
            // 保存成功：让 sync 在订阅事件中重读新值作为新草稿基线。
            setDraft(null);
          } else {
            setFeedback(t("saveError"));
          }
        } catch {
          setFeedback(t("saveError"));
        }
        setBusy(false);
      };

      return react_jsx_runtime.jsxs("div", {
        style: { maxWidth: 560 },
        children: [
          react_jsx_runtime.jsx("p", { style: { fontSize: 13, marginTop: 0 }, children: t("intro") }),
          react_jsx_runtime.jsx(Row, {
            label: t("enabled"),
            hint: t("enabledHint"),
            children: react_jsx_runtime.jsx(Toggle, {
              checked: draft.enable,
              onLabel: t("on"),
              offLabel: t("off"),
              onChange: (next) => setField("enable", next)
            })
          }),
          react_jsx_runtime.jsx(Row, {
            label: t("delayMs"),
            hint: t("delayMsHint"),
            children: react_jsx_runtime.jsx("input", {
              type: "number",
              min: 0,
              max: 3600000,
              value: draft.delayMs,
              disabled: !writable || busy,
              onChange: (event) => setField("delayMs", Number(event.target.value)),
              style: { width: 160, padding: "6px 8px", fontSize: 13 }
            })
          }),
          react_jsx_runtime.jsx(Row, {
            label: t("message"),
            hint: t("messageHint"),
            children: react_jsx_runtime.jsx("input", {
              type: "text",
              value: draft.message,
              disabled: !writable || busy,
              onChange: (event) => setField("message", event.target.value),
              style: { width: 280, padding: "6px 8px", fontSize: 13 }
            })
          }),
          react_jsx_runtime.jsx(Row, {
            label: t("codes"),
            hint: t("codesHint"),
            children: react_jsx_runtime.jsx("input", {
              type: "text",
              value: draft.codesText,
              disabled: !writable || busy,
              onChange: (event) => setField("codesText", event.target.value),
              style: { width: 280, padding: "6px 8px", fontSize: 13 }
            })
          }),
          react_jsx_runtime.jsx(Row, {
            label: t("excludeSubagents"),
            hint: t("excludeSubagentsHint"),
            children: react_jsx_runtime.jsx(Toggle, {
              checked: draft.excludeSubagents,
              onLabel: t("on"),
              offLabel: t("off"),
              onChange: (next) => setField("excludeSubagents", next)
            })
          }),
          react_jsx_runtime.jsx(Row, {
            label: t("maxContinues"),
            hint: t("maxContinuesHint"),
            children: react_jsx_runtime.jsx("input", {
              type: "number",
              min: 0,
              max: 100,
              value: draft.maxContinues,
              disabled: !writable || busy,
              onChange: (event) => setField("maxContinues", Number(event.target.value)),
              style: { width: 120, padding: "6px 8px", fontSize: 13 }
            })
          }),
          react_jsx_runtime.jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 12 },
            children: [
              react_jsx_runtime.jsx("button", {
                type: "button",
                disabled: !writable || busy,
                onClick: () => void saveAll(),
                style: {
                  padding: "6px 18px",
                  borderRadius: 6,
                  border: "1px solid #1a73e8",
                  background: "#1a73e8",
                  color: "#ffffff",
                  cursor: busy ? "default" : "pointer",
                  fontSize: 13
                },
                children: t("save")
              }),
              feedback ? react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "#888" }, children: feedback }) : null
            ]
          })
        ]
      });
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "429-auto-continue: dictionaries");
      } catch {
        /* already registered */
      }
      try {
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "429-auto-continue",
          order: 40,
          label: () => t("title"),
          locale: NS,
          inject: () => ({ form: resolveForm(ctx) })
        }, AutoContinuePanel));
      } catch (error) {
        try {
          console.error("[429-auto-continue] settings section registration failed", error);
        } catch {
          /* ignore */
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "configForms"];
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
