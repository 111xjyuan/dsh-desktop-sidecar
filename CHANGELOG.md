# 更新日志

## 0.5.3 — 2026-10-28

修社区反馈的两个问题（issue #3 / #4）。

### 修：`desktop_invoke` 可能点到「另一个名字相似的控件」（#3）

以前按子串匹配、取第一个命中，于是 `text:"内存"` 有可能命中父容器 `内存添加`：界面上什么都没发生、`done` 却可能是 true。

现在：

- 名字**完全一致**的控件优先；
- 子串命中多个时**一个都不点**，返回 `ambiguous:true` 和 `candidates`（名字 / 角色 / 矩形 / 能力），让你改用精确名字或加 `role`；
- 新增 `match: auto | exact | substring` 与 `role` 参数；
- 唯一可执行的情况下才动作，并在返回里带 `matchKind`（exact / substring）与 `rect`，方便事后核对点到的是谁。

### 新增：按名字点击 `desktop_click{name, role}`（#3）

`control:N` 的编号会随界面变化失效。现在可以直接写控件名，点击那一刻才定位：

```
desktop_click { window: "记事本", name: "保存", role: "Button" }
```

`desktop_sequence` 的 click 步骤同样支持 `{name, role, match}`。

### 修：`+` 键无法按（#4）

`desktop_key{"key":"+"}` 以前抛 `unknown key: +`，因为按 `+` 拆分组合键时把加号本身拆没了。现在：

- `"+"`、`"-"`、`"ctrl++"`、`"ctrl+shift++"` 都能正确解析；
- `+` 会自动补 Shift（美式/中文键位上 `+` 是 Shift+`=`），打出的是 `+` 而不是 `=`；
- 顺带支持 `f1`~`f24`、`plus` / `minus` / `comma` 等别名。

### 修：`desktop_doctor` 的 DPI 误报（#4）

以前只看 setter 的返回值。宿主进程如果已经设过 DPI 感知，再调 setter 会返回 false / E_ACCESSDENIED，于是被误判成「未启用 DPI 感知」。

现在改为查询进程真实级别（`GetProcessDpiAwareness`，回退 `GetThreadDpiAwarenessContext`），返回 `level: 0/1/2`；setter 失败但进程本身已感知时会在 detail 里注明，不再算失败。

### 文档

- `desktop_capture` 的 `x/y/width/height` 明确为「仅区域截图生效」，给了 `window` 就按整窗截。
