# Realtime Voice Input 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在桌面和浏览器中用麦克风音频做实时转写，把结果填入 agent composer 草稿，用户仍手动点击发送。

**架构：** 前端使用 `getUserMedia` + Web Audio 采集单声道 PCM16，按 chunk 调用后端 `sessions/:id/voice/*` REST API。后端维护每个 session 的临时 OpenAI Realtime WebSocket 转写连接，将 transcript delta/done/error/status 注入现有 session SSE 事件流。语音内容不写入 agent history，不自动触发 turn。

**技术栈：** Next.js client component、Nest/Fastify REST + SSE、Bun WebSocket、OpenAI Realtime-compatible event parsing、Bun/node:test。

---

## 文件结构

- 修改 `apps/server/src/sessions/sessions.controller.ts`：增加 `voice/start`、`voice/audio`、`voice/stop` 路由和请求体验证。
- 修改 `apps/server/src/sessions/sessions.service.ts`：增加 session event 注入能力，并把 voice lifecycle 委托给专用服务。
- 创建 `apps/server/src/sessions/voice-transcription.ts`：封装 Realtime WebSocket、音频 chunk 校验、事件解析、stop/cleanup。
- 修改 `apps/server/src/sessions/sessions.module.ts`：注册 `VoiceTranscriptionService`。
- 修改 `apps/server/test/voice-transcription.test.ts`：无网络 mock WebSocket 的服务测试。
- 修改 `apps/server/test/golden-path.e2e.test.ts`：验证 controller 路由和 SSE 语音事件桥接。
- 修改 `apps/web/app/agent/types.ts`：增加 voice SSE event union。
- 修改 `apps/web/app/agent/api.ts`：增加 voice start/audio/stop 客户端 API。
- 创建 `apps/web/app/agent/voice-recorder.ts`：封装 Web Audio PCM16 chunk 采集。
- 修改 `apps/web/app/agent/page.tsx`：mic 按钮启动/停止 recorder，把 voice transcript 事件填入 `draft`。
- 创建 `apps/web/test/agent-voice-api.test.ts`：验证 API shape。
- 创建 `apps/web/test/agent-voice-recorder.test.ts`：验证 float PCM 转 PCM16/base64 纯函数。
- 修改 `apps/web/test/agent-page-source.test.ts`：防止重新引入 `SpeechRecognition`，验证 voice 事件填草稿且不自动发送。

## 任务 1：后端 voice 事件和 API 骨架

- [ ] 编写失败测试：服务能把 voice transcript 事件注入 session SSE log/listeners；controller 暴露 `POST /sessions/:id/voice/start|audio|stop`。
- [ ] 运行 `bun test apps/server/test/voice-transcription.test.ts apps/server/test/golden-path.e2e.test.ts`，预期缺少文件/方法/路由而失败。
- [ ] 实现 `emitVoiceEvent`、controller 路由和 `VoiceTranscriptionService` 最小骨架。
- [ ] 运行同一测试，预期通过骨架相关断言。

## 任务 2：后端 Realtime WebSocket 转写

- [ ] 编写失败测试：mock WebSocket 收到 `session.update`、`input_audio_buffer.append`、`input_audio_buffer.commit`；OpenAI transcript delta/done/error 被转成 voice SSE event。
- [ ] 运行测试，预期失败。
- [ ] 实现 Realtime URL、鉴权 header、defensive event parser、start/audio/stop lifecycle。
- [ ] 运行测试，预期通过。

## 任务 3：前端录音与 API

- [ ] 编写失败测试：`floatToPcm16Base64` 正确夹取/转换，`startVoiceTranscription`/`appendVoiceAudio`/`stopVoiceTranscription` 调用正确路径和 body。
- [ ] 运行 `bun test apps/web/test/agent-voice-api.test.ts apps/web/test/agent-voice-recorder.test.ts`，预期失败。
- [ ] 实现 `voice-recorder.ts` 和 API helpers。
- [ ] 运行同一测试，预期通过。

## 任务 4：composer 集成

- [ ] 编写失败测试：页面源码不包含 `SpeechRecognition`；voice transcript 事件只调用 `setDraft`，不调用 `sendMessage`。
- [ ] 运行 `bun test apps/web/test/agent-page-source.test.ts`，预期失败。
- [ ] 替换 mic handler：有 session 才可录音，start 发送当前 OpenAI model config，audio chunk 发送后端，stop 清理 recorder 和后端连接。
- [ ] 处理状态：permission denied、start/audio/stop error、session 切换自动停止、按钮 listening 样式。
- [ ] 运行相关前端测试，预期通过。

## 任务 5：验证

- [ ] 运行 `bun test apps/server/test/voice-transcription.test.ts apps/server/test/golden-path.e2e.test.ts`。
- [ ] 运行 `bun test apps/web/test/agent-voice-api.test.ts apps/web/test/agent-voice-recorder.test.ts apps/web/test/agent-page-source.test.ts apps/web/test/agent-desktop.test.ts`。
- [ ] 运行 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`，确认 macOS plist 防线仍在。
- [ ] 检查 `git diff --stat` 和关键 diff，只总结本次语音相关变更。
