# Schema Authoring Foundation 0B-7 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-6 经用户验收后才能执行；完成后停在 0B-7 Gate。

**目标：** 冻结 authenticated principal、daemon discovery、CredentialRef、config patch、policy patch 与 credential revocation 公共事件，并建立 secret 不进入公共契约的静态检查。

**架构：** auth/config/policy schema 只表达公共边界和 reference；secret material 没有任何公共 schema。Principal 是服务端认证结果，只能出现在 response/context contract，不能进入 command body。Policy patch 是声明式输入，diff classification 始终由 server 计算且不在请求 schema。

**技术栈：** Zod 4、TypeScript、Bun test

---

### 任务 1：Authenticated principal 与 daemon discovery

**文件：** `packages/schema/src/auth.ts`、`packages/schema/test/auth-contracts.test.ts`

- [ ] **步骤 1：写 principal 红灯测试**

strict principal：`principalId,clientIdentity,kind,authenticatedAt,credentialVersion,capabilities`；kind 为 `installationClient | system`。clientIdentity 是返回字段，测试遍历全部 command body 并确认无法提交。禁止 bearer token、authorization header、peer UID/SID、signing key。

- [ ] **步骤 2：写 DaemonDiscovery 红灯测试**

精确 shape：`endpoint,daemonInstanceId,tokenRef,protocolVersion:'2'`。endpoint 只允许受支持的 `http://127.0.0.1:<port>`、`unix:` 或 `npipe:` 表示；禁止 token value、URL query token 和 remote host。

- [ ] **步骤 3：实现与验证**

schema description 说明 tokenRef 是 OS credential-store reference；不实现本地认证服务、token rotation 或 discovery file IO。

### 任务 2：CredentialRef 与 Config patch

**文件：** `packages/schema/src/config.ts`、`packages/schema/test/config-contracts.test.ts`

- [ ] **步骤 1：定义 CredentialRef**

strict `{ credentialRef,provider,label,createdAt }`；credentialRef 使用 branded ID。拒绝 value/token/apiKey/password/headers/secret/serializedCredential。

- [ ] **步骤 2：定义 configPatchSchema**

允许字段：`model?`、`provider?`、`providerCredentialRef?`、`temperature?`、`topP?`、`maxOutputTokens?`、`reasoningEffort?`、`providerOptions?`。providerOptions 仅 JSON scalar/array/object 且经过 secret-key recursive refine。patch 至少一个字段；禁止 trust/sandbox/network/plugin permissions/revocation。

- [ ] **步骤 3：验证数值与 nullable 语义**

temperature 0..2、topP 0..1、maxOutputTokens 正 safe integer；credential ref 使用 nullable 表示显式清除，optional 表示不修改。未知 provider option key 默认允许但只要 key 命中 secret denylist 就 reject。

### 任务 3：Policy patch 与 server-owned classification

**文件：** `packages/schema/src/policy.ts`、`packages/schema/test/policy-contracts.test.ts`

- [ ] **步骤 1：写 policy 红灯测试**

允许：`workspaceTrust`、`sandbox`、`network`、`pluginCapabilities`、`credentialRefs`、`revokeCredentialRefs`。sandbox 为 `readOnly | workspaceWrite | unrestricted`；network 为 strict `{ mode:'denyAll'|'allowListed',allowedHosts? }`；plugin capability 为 strict `{ pluginId,capability,decision:'allow'|'deny' }`。

- [ ] **步骤 2：禁止 client classification**

注入 `classification`、`isTightening`、`isRelaxation`、`mixed`、`effectivePolicy`、`policyRevision` 必须 reject。patch 至少一个字段，所有 array 去重，host 使用规范小写 hostname、不允许 URL credential。

- [ ] **步骤 3：接回 Config/Policy command**

0B-4 command shell 改为引用最终 patch schema；重新运行 registry invariant，确保 commandId 与 expected revision 保留。

### 任务 4：Credential revocation event 与 Secret Gate

**文件：** `packages/schema/src/events.ts`、`packages/schema/test/credential-revocation-event.test.ts`、`packages/schema/test/public-secret-boundary.test.ts`

- [ ] **步骤 1：定义 revocation durable event**

kind `credential.revoked`，payload strict `{ credentialRef,provider,revokedAt,reason }`；无 secret/value/token。当前 Thread 由 event envelope 的 threadId 唯一确定，payload 禁止 `affectedThreadIds` 或其他 Thread ID 集合。服务端跨 Thread fan-out 属于内部协调，不进入公共契约。将该事件加入 known durable union，并验证旧 known events 不受影响。

- [ ] **步骤 2：建立递归 secret-key 检查**

对所有 exported Zod schemas 生成 JSON Schema 并递归扫描 property names/examples/default/description。禁止公共字段：`secret`、`apiKey`、`accessToken`、`refreshToken`、`password`、`privateKey`、`authorization`、`cookie`、`credentialValue`；允许 `tokenRef` 和 `credentialRef` 精确白名单。匹配大小写、snake_case、kebab-case 归一化结果。

- [ ] **步骤 3：添加正反 fixture**

CredentialRef、DaemonDiscovery tokenRef、policy credentialRefs 必须通过；任意层级 secret-bearing providerOptions、event payload、command body 必须拒绝。错误信息输出 schema 名和 property path，不输出被拒值。

- [ ] **步骤 4：完整验证与中间提交**

运行 test、lint、typecheck、build、format、diff check；主代理复核 secret 扫描不会打印敏感 fixture、principal 不可伪造、patch 无 mutable registry。最后修正未提交。

## 0B-7 Gate

- principal、discovery、CredentialRef、config/policy patch 和 revocation event 全部冻结；
- command body 无 clientIdentity，公共 schema 无 credential material；
- secret recursive negative fixtures 全部 reject 且诊断不回显值；
- 没有 Credential Broker、认证服务、Policy Reconcile 或 Config/Policy 状态机；
- 全部验证通过后停止，等待用户验收。
