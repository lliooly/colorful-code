# Colorful Code — Keynote 脚本

> Apple 风格发布演示，总时长约 45-60 分钟

---

## 🎬 开场视频 (2 分钟)

**画面：纯黑背景**

字幕逐行淡入：

> "Writing code has never been easier."
>
> "AI can generate functions, classes, entire applications in seconds."
>
> "But something is missing."

**画面：快速剪辑 — IDE 截图、终端命令、浏览器 DevTools、配置文件、环境变量、CI 日志**

> "The agent doesn't live in your editor."
>
> "It doesn't understand your project."
>
> "It can't see your terminal, your file system, your tools."
>
> "Until now."

**画面：Colorful Code logo 亮起**

---

## Slide 1 — 开场 (3 分钟)

**舞台：暗场，一束追光**

> "Good morning."
>
> "Welcome."
>
> "Today, we're going to talk about something that matters deeply to every developer in this room."
>
> "How we build software."

**[点击：屏幕上出现一张巨大的图表]**

> "Last year alone, developers worldwide wrote over 100 billion lines of new code."
>
> "AI assistants have changed *how* we write code — autocomplete, chat, inline suggestions."
>
> "But they haven't changed *how we work*."
>
> "You still switch between your editor, your terminal, your browser, your documentation, your CI dashboard —"
>
> "All day, every day."

**[点击：碎片化工具的拼贴画]**

> "What if your AI agent wasn't just a chatbot in a sidebar?"
>
> "What if it was the center of your workflow?"
>
> "What if it could read your files, run your tests, manage your dependencies, deploy your code —"
>
> "While you focused on the things that actually matter?"

**[点击：Colorful Code logo]**

> "This is Colorful Code."
>
> "The first AI agent built for how developers *actually* work."
>
> "And we think you're going to love it."

---

## Slide 2 — 产品愿景 (3 分钟)

**画面：一张大图，三条产品支柱**

```
          ┌─────────────────────────────────┐
          │         COLORFUL CODE           │
          ├─────────┬───────────┬───────────┤
          │  Agent  │  Desktop  │  Open     │
          │  First  │  Native   │  Platform │
          └─────────┴───────────┴───────────┘
```

> "Colorful Code is built on three core beliefs."

> **第一支柱：**
> "**Agent First.** Not a chat window. Not an autocomplete popup. A real agent. It plans, it reads, it writes, it runs commands, it checks the results, and it iterates — autonomously. You review. You approve. You ship."

> **第二支柱：**
> "**Desktop Native.** This is not a web app pretending to be a desktop experience. This is a real, native desktop application — built with Tauri and Rust — that has full access to your file system, your terminal, your local tools. No sandbox that gets in your way. No 'please upload your folder.' Just open, and work."

> **第三支柱：**
> "**Open Platform.** Every tool is a plugin. Every model is swappable. MCP servers, LSP language servers, custom skills — all work together in one unified runtime. You're not locked in to any provider, any model, any workflow."
>
> "Agent First. Desktop Native. Open Platform."
>
> "This is what an AI coding agent should have been from day one."

---

## Slide 3 — 产品 Demo 1：Agent 日常工作流 (5 分钟)

**[舞台转暗，屏幕切换到实况 Demo]**

**场景：一个真实的项目文件夹**

> "Let me show you what this looks like in practice."
>
> "I have a project here — a TypeScript monorepo. Let's say I want to add a new feature: real-time notifications."
>
> "Watch this."

**[在 composer 中输入]**

```
Add real-time notification support using WebSockets.
Create the module on the server, add the client hook, and write tests.
```

**[点击发送]**

> "The agent doesn't just start writing code blindly."

**[屏幕显示 agent 的思考过程]**

> "First, it reads the project structure. It understands we're using NestJS on the backend, Next.js on the frontend. It sees the monorepo layout, the existing patterns."
>
> "It plans the files it needs to create."
>
> "Then — and this is critical — it asks me to approve the plan."

**[点击 Approve]**

> "Now watch. It creates the WebSocket gateway on the server. The React hook on the client. The tests. It runs the tests. A test fails — it reads the error, fixes the code, runs again. Green."
>
> "All in one continuous flow."

**[Demo 完成]**

> "This is not a demo. This is how Colorful Code works, every day, on real projects."

---

## Slide 4 — 技术深潜：Tool 引擎 (5 分钟)

**画面：架构图**

```
┌──────────────────────────────────────────────────────┐
│                   TOOL RUNTIME                        │
│                                                       │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Tool    │  │ Permission│  │ Session Engine     │  │
│  │ Descriptor│ │ Policy   │  │ (SSE + Control)    │  │
│  └─────────┘  └──────────┘  └────────────────────┘  │
│       │             │                  │              │
│  ┌────┴─────────────┴──────────────────┴──────────┐  │
│  │              Tool Scheduler                     │  │
│  │   concurrent-safe → parallel                    │  │
│  │   mutating → serial                             │  │
│  └─────────────────────────────────────────────────┘  │
│       │             │                  │              │
│  ┌────┴────┐  ┌─────┴──────┐  ┌───────┴──────────┐  │
│  │ Built-in│  │ MCP Tools  │  │ LSP Tools        │  │
│  │ Read    │  │ (Registry) │  │ (TypeScript, Go, │  │
│  │ Write   │  │            │  │  Rust, Python...) │  │
│  │ Edit    │  │            │  │                   │  │
│  │ Bash    │  │            │  │                   │  │
│  │ Glob    │  │            │  │                   │  │
│  │ Grep    │  │            │  │                   │  │
│  └─────────┘  └────────────┘  └───────────────────┘  │
└──────────────────────────────────────────────────────┘
```

> "Let's go deeper. The heart of Colorful Code is the Tool Runtime."
>
> "Every action the agent can take — reading a file, running a command, searching your codebase, calling an external API — is a Tool. Each tool has a descriptor that tells the model what it does. Each tool has an input schema validated at runtime. Each tool has safety flags: is it read-only? Is it destructive? Can it run in parallel with other tools?"
>
> "But the real innovation is the **permission system.**"

**[点击]**

```
┌────────────────────────────────────────────────┐
│            PERMISSION RESOLUTION                │
│                                                 │
│  1. Tool self-check   →  readOnly? destructive? │
│  2. Mode policy       →  plan | acceptEdits |   │
│                          readOnly | bypass       │
│  3. User rules        →  "always allow git *"   │
│  4. MCP trust         →  trusted | ask | blocked │
│  5. Global policy     →  workspace roots,        │
│                          network access          │
│                                                 │
│  Result: allow | deny | ask (with audit trail)  │
└────────────────────────────────────────────────┘
```

> "Five layers of permission resolution. Every tool call goes through all five. And every decision is audited."
>
> "This is not a toy. This is a system designed for production code, on real projects, where you need to trust your agent."

---

## Slide 5 — 安全第一 (3 分钟)

> "Let me tell you why this matters."

**[画面：一个典型的 AI 编码灾难场景]**

> "We've all seen the horror stories. An AI agent deletes a critical file. It pushes secrets to a public repo. It runs a command that takes down production."
>
> "Colorful Code has multiple lines of defense."

```
Line 1: Edit tools REQUIRE a prior Read — no blind edits
Line 2: Edit checks file mtime before writing — stale edit rejection
Line 3: Permission modes — Plan mode allows NO mutations
Line 4: Workspace root boundaries — can't touch files outside your project
Line 5: Network access requires explicit opt-in
Line 6: MCP servers have trust levels — untrusted servers can't auto-execute
```

> "Six lines of defense. Built in. Always on."
>
> "You get the productivity of an autonomous agent, with the safety of manual review."

---

## Slide 6 — 多模型 + 多 Provider (3 分钟)

**画面：一排模型 logo**

```
  Anthropic    OpenAI    DeepSeek
  (Claude)     (GPT)     (DeepSeek)
```

> "One more thing about the runtime."
>
> "We don't believe in lock-in. Colorful Code supports Anthropic, OpenAI, and DeepSeek — and the Model Client interface means adding a new provider is a single file."
>
> "You choose the model. You control the API key. You own your data."
>
> "And because the tool descriptors are model-agnostic, switching models doesn't break your workflow."

---

## Slide 7 — Demo 2：MCP 插件生态 (5 分钟)

**[实况 Demo]**

> "Let me show you something really cool."

**[点击侧边栏 Puzzle 图标]**

> "Colorful Code has a built-in plugin system. It's connected to the MCP Registry — the Model Context Protocol ecosystem."

**[浏览 MCP Registry]**

> "There are hundreds of MCP servers out there. Database tools. Cloud services. Design systems. Development tools. With one click, you install them into Colorful Code."
>
> "Let's install the PostgreSQL MCP server."

**[点击 Install]**

> "Done. Now my agent can inspect database schemas, run queries, analyze data — directly. No configuration files. No manual setup."
>
> "And this works for Skills and LSP language servers too."

**[切换到 Skills catalog]**

> "Custom skills — like code review, security audit, deployment checklists — one click install."
>
> "This is what an open platform looks like."

---

## Slide 8 — Demo 3：语音输入 (3 分钟)

**[实况 Demo]**

> "Sometimes you don't want to type. Sometimes you're thinking out loud, walking through a problem, and you want the agent to follow along."

**[点击麦克风按钮]**

> "Colorful Code has real-time voice transcription built in."

**[开始说话]**

> *"Find all the places in this project where we handle authentication, and check if there are any security issues with the JWT token handling."*

**[文字实时出现在 composer 中]**

> "The transcription happens in real time — streaming to OpenAI's Realtime API and back into the composer as a draft. You review it, maybe edit it, then send."
>
> "It's not a voice-to-command system. It's voice as input. You still control what gets sent to the agent."
>
> "And it works on desktop and in the browser."

---

## Slide 9 — 桌面体验 (3 分钟)

**画面：Tauri 2 桌面应用在 macOS 上的截图**

> "Now, I mentioned this is a desktop-native application. Let me explain why that matters."

**[对比图：Web app vs Desktop app]**

| Web App | Colorful Code Desktop |
|---------|----------------------|
| Sandboxed file access | Full filesystem access |
| No native terminal | Integrated terminal |
| Browser tab, easily lost | Native window, always there |
| Limited to browser protocols | Full system integration |

> "Colorful Code runs as a native desktop app built on Tauri 2. That means it's fast — the core is Rust. It's small — the binary is measured in megabytes, not gigabytes. And it has real access to your machine."
>
> "Your project folders. Your terminal. Your local tools and binaries. Everything the agent needs, without sandbox limitations."

---

## Slide 10 — 项目与历史 (2 分钟)

**画面：侧边栏结构**

```
  📁 Projects
    ├─ 🗂 my-api-server
    │   ├─ 💬 Add WebSocket support
    │   └─ 💬 Fix auth middleware
    ├─ 🗂 frontend-app
    │   └─ 💬 Refactor state management
    └─ 🗂 infrastructure
        └─ 💬 Update CI pipeline

  💬 Chats
    ├─ 📌 Quick question about Rust
    ├─ 💬 Debug production error
    └─ 💬 Review PR #342
```

> "Every conversation in Colorful Code is organized by project. Import a folder, and every chat you start from that project automatically gets the right working directory, the right workspace roots, the right context."
>
> "Standalone chats live separately — for quick questions, code reviews, anything that doesn't belong to a project."
>
> "Pin what matters. Delete what doesn't. Your history, organized the way you work."

---

## Slide 11 — CLI 和 CI/CD (2 分钟)

**画面：终端截图**

```bash
$ colorful-code "Run the test suite and fix any failing tests"

  ✓ Reading test files...
  ✓ Found 3 failing tests
  ✓ Fixed auth middleware test
  ✓ Fixed user model validation
  ✓ Fixed API response format
  ✓ All 42 tests passing

  Done. 3 fixes applied.
```

> "Colorful Code isn't just a desktop app. There's a CLI. And it works in CI."
>
> "Imagine: a PR comes in. Your CI pipeline runs the tests. Some fail. Colorful Code automatically reads the failures, fixes the code, pushes a commit. Your reviewer gets a green build without ever looking at it."
>
> "This is the future of automated development."

---

## Slide 12 — 架构全景 (2 分钟)

> "Before I wrap up, let me show you the big picture."

```
┌─────────────────────────────────────────────────────────┐
│                   COLORFUL CODE                          │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Desktop  │  │   Web    │  │   CLI    │  ← Apps      │
│  │ (Tauri)  │  │ (Next.js)│  │  (Bun)   │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │              │                    │
│       └──────────────┼──────────────┘                    │
│                      │                                   │
│              ┌───────┴───────┐                           │
│              │  NestJS API   │  ← Server                 │
│              │  (Fastify)    │                           │
│              └───────┬───────┘                           │
│                      │                                   │
│       ┌──────────────┼──────────────┐                    │
│       │              │              │                    │
│  ┌────┴────┐  ┌──────┴──────┐ ┌────┴────┐              │
│  │ Tool    │  │  Session    │ │ Plugin  │ ← Packages   │
│  │ Runtime │  │  Engine     │ │ Registry│              │
│  └────┬────┘  └──────┬──────┘ └────┬────┘              │
│       │              │              │                    │
│  ┌────┴──────────────┴──────────────┴────┐              │
│  │          SQLite (Drizzle ORM)          │ ← Data      │
│  └────────────────────────────────────────┘              │
│                                                          │
│  Models: Anthropic · OpenAI · DeepSeek                   │
│  Desktop: Tauri 2 · Rust                                 │
│  Build: pnpm · Turborepo · Bazel                         │
└──────────────────────────────────────────────────────────┘
```

> "One monorepo. Four apps — desktop, web, CLI, and server. Five shared packages — tool runtime, session engine, UI components, shared schemas, and prompts."
>
> "TypeScript across the entire stack. Rust where it matters for performance. SQLite for persistence — zero configuration, runs everywhere."
>
> "This is the most complete AI coding agent platform ever built."

---

## Slide 13 — 对比 (2 分钟)

**画面：对比表**

```
┌──────────────────┬──────────┬──────────┬──────────────┐
│                  │ Copilot  │  Cursor  │ Colorful Code │
├──────────────────┼──────────┼──────────┼──────────────┤
│ Agentic workflow │    ✗     │    △     │      ✓       │
│ Desktop native   │    ✗     │    ✗     │      ✓       │
│ Multi-model      │    ✗     │    △     │      ✓       │
│ MCP ecosystem    │    ✗     │    ✗     │      ✓       │
│ Built-in voice   │    ✗     │    ✗     │      ✓       │
│ Permission system│    ✗     │    ✗     │      ✓       │
│ Open source      │    ✗     │    ✗     │      ✓       │
│ CLI + CI/CD      │    △     │    ✗     │      ✓       │
│ Plugin registry  │    ✗     │    ✗     │      ✓       │
│ Project history  │    △     │    △     │      ✓       │
└──────────────────┴──────────┴──────────┴──────────────┘
```

> "When you look at what's available today —"
>
> "Nothing else gives you the agent, the platform, and the desktop experience in one package."
>
> "Nothing else is open."
>
> "Nothing else puts you in control like this."

---

## Slide 14 — Roadmap & 下一步 (2 分钟)

> "We're close to the finish line. Here's what's done, and what's coming."

```
✅ Done
  • Monorepo scaffold + CI/CD
  • Tool runtime (Read, Write, Edit, Bash, Glob, Grep + more)
  • Permission system (5-layer, 3-state, audited)
  • Session engine (SSE events + bidirectional control)
  • MCP Plugin Registry + Unified Plugin Catalog
  • LSP integration (TypeScript, Go, Rust, Python...)
  • Voice transcription (real-time, streaming)
  • Projects & Chat History
  • Context auto-compaction
  • Hook system
  • Multi-model adapters (Anthropic, OpenAI, DeepSeek)
  • CLI client
  • Desktop shell (Tauri 2)

🔜 Coming
  • Tauri desktop deep integration (native menus, shortcuts, system tray)
  • Sandbox execution (isolated filesystem + network per session)
  • Remote sync (history across machines)
  • Team collaboration (shared projects, shared plugins)
```

---

## Slide 15 — "One More Thing" (2 分钟)

**[舞台变暗]**

> "There is one more thing."

**[画面：一张概念图 — Agent-to-Agent 协作]**

> "We've been talking about you, the developer, working with an agent."
>
> "But what if agents could work with each other?"
>
> "What if you could spawn a code review agent, a security audit agent, and a performance optimization agent — all in parallel — watching the same codebase, collaborating on the same problem?"
>
> "We call it **Agent Mesh.**"
>
> "Coming later this year."
>
> "This is the future of software development. Not one developer, one agent. But one developer, orchestrating a team of agents, each specialized, each working in parallel."
>
> "That future is closer than you think."

---

## Slide 16 — 定价与可用性 (1 分钟)

> "Colorful Code will be available in two editions."

```
┌──────────────────────┬──────────────────────┐
│   Community          │   Pro                 │
│                      │                      │
│   Free               │   $10/month           │
│   Open source        │   Everything in       │
│   Self-hosted        │   Community +         │
│   Bring your own     │   Priority support    │
│   API keys           │   Early access to     │
│                      │   new features        │
│                      │   Agent Mesh (beta)   │
└──────────────────────┴──────────────────────┘
```

> "Community Edition is free, forever. Open source. Use any model, any provider — bring your own API keys."
>
> "Pro is for teams who want priority support, early features, and the platform managed for them."
>
> "Public beta starts next month. Sign up at colorful-code.dev."

---

## Slide 17 — 总结视频 + 致谢 (2 分钟)

**画面：快速剪辑的蒙太奇 — 前面展示过的所有功能**

背景音乐渐强。

旁白：

> "Colorful Code."
>
> "Your project. Your tools. Your models."
>
> "Agent First. Desktop Native. Open Platform."
>
> "Available next month."

**画面黑屏，Colorful Code logo 淡入**

> "Thank you."

---

## 🎯 Apple 风格要素 Checklist

Keynote 制作时请确保：

### 视觉风格
- [ ] 纯黑或深灰背景 (`#1a1a1a` 或纯黑)
- [ ] San Francisco 字体（标题用 SF Pro Display，正文用 SF Pro Text）
- [ ] 巨大的、单行的标题（60-80pt，极少情况下两行）
- [ ] 大量留白，每张幻灯片通常只放一个想法
- [ ] 产品截图要大、边缘带设备框架
- [ ] 过渡动画流畅、缓慢、有重量感（Magic Move / Morph）
- [ ] 关键数字用巨大的字体 + 渐变色彩

### 色彩方案
- 主色：从 "#7C3AED" (紫色) → "#3B82F6" (蓝色) 渐变
- 强调色： "#F59E0B" (金色, 用于星标和新功能标记)
- 正文：白色 `#FFFFFF` 或浅灰 `#A1A1A6`
- 代码块：深色终端风格 `#0D1117`

### 演讲风格
- [ ] 语速：慢、自信、停顿多。Steve Jobs 每分钟约 130-140 词
- [ ] 手势：大量使用"这个"、"看"、手指向屏幕
- [ ] 短句。极少从句
- [ ] 在 Demo 之间重复核心信息
- [ ] "We think you're going to love it" 至少 3 次

### 幻灯片内容
- [ ] 每张幻灯片不超过 7 个词（展示用幻灯片应是视觉辅助，不是讲稿）
- [ ] 代码和技术细节用演示展示，不在幻灯片上
- [ ] 对比数据可视化（柱状图 > 表格 > 纯文字）

### Demo 准备
- [ ] 每个 Demo 至少有 1 个后备方案（预录视频）
- [ ] Demo 环境完全隔离，不依赖互联网连接
- [ ] 提前清理桌面、浏览器历史、终端历史

---

## 📋 制作任务清单

1. **Keynote 文件创建** (2-3 天)
   - 创建 17 张主幻灯片
   - 设计过渡动画
   - 制作产品 mockup

2. **开场视频** (3-5 天)
   - 编写分镜
   - 录制屏幕操作
   - 剪辑 + 配乐

3. **Demo 准备** (3-5 天)
   - Demo 1: 日常 agent 工作流
   - Demo 2: MCP 插件安装
   - Demo 3: 语音输入
   - 每个 Demo 准备备用录屏

4. **演讲练习** (3-5 天)
   - 完整走场，计时
   - 与幻灯片动画同步
   - 排练 Demo 之间的过渡

5. **技术准备**
   - 演示专用机器（干净环境）
   - 备用机器（处于相同状态）
   - 屏幕录制作为最终后备

---

> 总演讲时长：约 45 分钟
> 建议幻灯片数：17 张主幻灯片 + Demo 过渡
> 目标感受：专业、精美、有野心、可信赖
