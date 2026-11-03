# 个人电台（personal-radio）路线图与跨会话交接

> 本文件是**唯一权威的后续开发规格**。新会话开工前先读本文件，不要凭记忆猜测。
> 当前版本：v0.2.0（P1 + AI 标签补全）。下一步：P2。

## 0. 不可违背的边界

1. **不改动其他插件**：不 fork、不修改 `songloft-plugin-miot`、`songloft-ncm-daily`、`ncmqr`。只能调用它们公开的 HTTP 接口。
2. **本插件独立成仓**：所有改动只发生在 `Cxquang/songloft-personal-radio`。
3. **算法来源固定**：打分内核移植自抖歌 v1.4.7（Apache-2.0），只移植纯函数，不 fork 仓库。
4. **宿主字段限制不可绕过**：Songloft 歌曲对象没有 `genre/style/language/year`。流派/风格/语种/年代只能来自本插件的 `songTags`（AI 或人工）与歌手标签兜底。
5. **行为采集只能轮询 `/player/status`**（P3），不依赖 `songloft.events.onPlayEvent`。
6. **miot Webhook 提问文本只从 `messages[].message.response.answer[].question` 取**，不要用顶层 `query`。
7. **不存管理员账号密码**。优先用宿主插件令牌调 miot；只有实测不通才加 JWT 兜底，且必须写进本节作为已知例外。
8. **所有存储 key 以 `personalRadio.` 开头**；多画像数据必须按 `profile.{id}.` 隔离。
9. 每阶段完成后先自测、再汇报、**等用户确认后才进入下一阶段**。

## 1. 已知环境与实测事实

| 项 | 值 |
|---|---|
| Songloft 访问地址 | `https://songloft.oneblood.top` |
| miot 插件基址 | `http://192.168.123.176:58091/api/v1/jsplugin/miot` |
| 宿主/插件关系 | miot 是同一 Songloft 实例的插件（高概率，P2 需实测确认） |
| 小爱音箱 | 二楼客厅音箱、一楼客厅音箱、阳台房音箱；新增设备以房间名为前缀 |
| 收藏歌单 | 名为「收藏」，实测仅 1 首；另有「蔡贤权喜欢的音乐」（个人歌单导入） |
| 曲库实测 | 候选 997 首，收藏 1 首 |
| AI 接口 | OpenAI 兼容，DeepSeek（`https://api.deepseek.com/v1`，模型 `deepseek-chat`） |
| 插件权限 | `storage / songs.read / playlists.read / playlists.write / net` |

**未确认、P2 开工必须先测的点**：`songloft.plugin.getToken()` 是否存在、miot 的 `account_id/device_id` 从哪个接口取、Webhook 推送体是否严格符合上述路径、`publicPaths` 实际挂载 URL。

## 2. 当前已完成（v0.2.0）

- 多画像（默认「我」，可增删改、别名唯一、默认画像、最后画像禁删）
- 抖歌内核：12 维打分、时间衰减、置信度、长期层、探索比例、多样性约束、FNV-1a 抖动、推荐池 100/批 20
- 收藏同步与逐画像 `useFavorites` 开关
- 歌手标签库 + 手动画像（歌手/标签 ±1.0）
- 歌曲级四维标签 `songTags`：`{ g, s, l, d, src, conf, locked, at }`，歌曲级优先于歌手级
- 零成本语种识别（谚文→韩语、假名→日语、汉字→华语、拉丁→欧美）
- AI 批量打标（OpenAI 兼容）：服务商预设、BaseURL 归一、自定义请求头、超时、JSON 模式、批量、并发、最低置信度、单次上限、进度持久化、停止
- 页面：AI 设置卡、覆盖率、标签云、单曲标签弹层（锁定保护）
- 自测 89 项全绿

**验收命令**：`npm run verify`、`npm run build`。

## 3. P2：语音桥接（下一步，唯一在范围内的工作）

### 3.1 目标（可验收）

对小爱说「播放老妈喜欢的」→ 3 秒内：
1. miot 把对话 Webhook 推到本插件；
2. 本插件命中画像「老妈」；
3. 生成 20 首推荐并写入歌单「老妈-推荐-YYYYMMDD」；
4. 调 miot `/player/play` 让指定音箱出声；
5. miot 回一句「正在播放老妈的今日推荐」。

### 3.2 明确不做

- 不做语音识别（miot 负责）
- 不改 miot 任何代码
- 不做多设备并发播放调度（P2 只支持单设备默认；多设备映射放 P4）
- 不做行为回写（P3）

### 3.3 新增配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `bridgeEnabled` | false | 桥接总开关 |
| `hookSecret` | 空 | Webhook 校验密钥；为空则拒绝 `/public/hook`（安全默认） |
| `miotAccountId` | 空 | miot 账号 ID，P2 实测后获得 |
| `defaultDeviceId` | 空 | 默认音箱设备 ID |
| `playMode` | `sequential` | 传给 `/player/play` 的 `play_mode` |
| `startPosition` | `random` | `first` / `resume` / `random` |
| `playlistSuffix` | `-推荐` | 歌单名前缀规则：`{画像名}{suffix}-{YYYYMMDD}` |
| `hookReplyText` | 开 | 是否回 TTS 文案 |
| `pollIntervalMs` | 2500 | P3 轮询间隔，P2 只保存不启用 |

### 3.4 端点：`POST /public/hook`

- **路径**：`/api/v1/jsplugin/personal-radio/public/hook`（实际挂载前缀开工时用浏览器网络面板确认，写死前先实测）
- **免 JWT**，但必须校验 `?key=` 或请求头 `X-Hook-Secret`，与 `hookSecret` 常量时间比较；不匹配返回 403，且不泄露配置
- **只接受 POST**；其他方法 405
- **读 body**：兼容 `{ messages: [...] }` 与直接数组
- **提问提取**：遍历 `messages[]`，取 `message.response.answer[].question`，取最后一条非空；同时保留 `device_id` / `account_id`（若存在）
- **幂等**：同一 `device_id + question` 在 90 秒内重复推送，返回上次结果，不重复建歌单/不重复播

### 3.5 口令匹配算法（必须按此实现）

1. 归一化：去首尾空白、全角转半角、去标点，压缩空格
2. 去口语前缀/后缀：`播放`、`来点`、`听听`、`放一首`、`的歌`、`喜欢的`、`的音乐`、`歌单`、`推荐`
3. 候选集合 = 所有画像的 `name + aliases`，另加固定词：`我的` → 默认画像
4. **最长匹配优先**（字符数降序），同长度按画像创建时间早者优先
5. 命中返回 `profileId`；未命中返回 200 + `{ handled: false, reply: '没有找到对应的画像，可以说「播放我的推荐」' }`
6. 多个画像同时命中只取最长的一个，避免「老妈」吃掉「老妈的朋友」

### 3.6 生成与播放流程

```
hook 命中 profileId
  → rankForProfile(profile, 20)          // 复用现有排序与池
  → 确保歌单存在：GET /api/playlists → 按名称精确匹配
      不存在则 create；存在则先清空再 addSongs（避免日期内重复）
  → 取 playlist.id
  → POST {miotBase}/player/play
      body: { account_id, device_id, playlist_id, play_mode, start_position }
  → 返回 { handled: true, profile, playlistId, count, reply }
```

失败降级：
- 无候选歌 → 200 `{ handled: true, reply: '画像「X」暂时没有可推荐的歌' }`，不建空歌单
- miot 不可达 → 仍然建歌单，返回 `{ handled: true, playback: false, reply: '歌单已生成，但音箱连接失败' }`
- 播放失败只记 WARN，不让 hook 500

### 3.7 调 miot 的鉴权（按优先级）

1. **首选**：`songloft.plugin.getToken()` + `songloft.plugin.getHostUrl()`，以 `Authorization: Bearer <token>` 调 `{host}/api/v1/jsplugin/miot/...`
2. **兜底**：若宿主无上述 API，才允许 `POST {songloftBase}/auth/login`（管理员账号）拿 JWT，缓存并在 401 时自动重登；该兜底必须在代码注释与本文件第 0 节标注
3. 所有 miot 请求设置 5–30 秒超时，错误信息脱敏（不打印 token）

### 3.8 页面新增（P2）

- 「语音桥接」卡片：桥接开关、hook 密钥（生成按钮）、miot 地址、account_id、默认设备、播放模式、起始位置、歌单后缀
- 「桥接诊断」：显示 hook 完整 URL、复制按钮、最近 20 次调用（时间/问题/命中画像/结果/耗时）
- 「模拟口令」输入框：输入「播放老妈喜欢的」→ 走同一套匹配与生成，但**默认不触发播放**，只显示会命中谁、生成多少首
- 「导出诊断 JSON」：脱敏后的配置 + 最近调用 + 版本 + 自测状态

### 3.9 P2 自测（追加到 `scripts/verify.mjs`）

必须新增 ≥20 项，覆盖：
1. hook 缺少 key → 403
2. hook 错误 key → 403
3. 非 POST → 405
4. 从嵌套路径提取 question
5. 别名「妈妈」命中「老妈」
6. 最长匹配（新增画像「老妈的朋友」后仍命中「老妈」）
7. 未命中 → `handled:false`
8. 播放口令 + 默认画像 → `我的`
9. 歌单创建（mock playlists.create）
10. 歌单已存在 → 清空后重加，不重复创建
11. 20 首推荐写入
12. miot 不可达 → `playback:false` 且 200
13. 无候选 → 不建空歌单
14. 幂等：90 秒内重复请求不重复建单
15. 模拟口令端点默认不播放
16. 诊断导出不含密钥
17. 配置保存与脱敏
18. 关闭桥接时 hook → 403
19. hook 请求体为数组也能解析
20. 播放成功返回 `playlistId + count + reply`

### 3.10 P2 验收标准

- [ ] 真机：对任一音箱说「播放老妈喜欢的」，3 秒内出声，歌单名正确
- [ ] 说「播放我的推荐」命中默认画像
- [ ] 说「播放老妹喜欢的」在未建画像时得到友好提示而非报错
- [ ] 错误 key 被 403 拒绝
- [ ] 页面模拟口令可显示命中与数量
- [ ] 自测 ≥109 项全绿，构建通过
- [ ] README 增加 P2 配置与 hook 说明
- [ ] 发布 v0.3.0

### 3.11 P2 风险与待确认

| 风险 | 处理 |
|---|---|
| `publicPaths` 实际 URL 不确定 | 页面显示完整 hook URL；先在浏览器里 GET 探活 |
| 宿主无 `getToken()` | 走 JWT 兜底，必须记录为已知例外 |
| miot 需要 `account_id` | 加「读取 miot 账号/设备」按钮，实测后写入配置 |
| 歌单被并发写坏 | 单实例互斥锁（内存 boolean）+ 失败重试一次 |
| Webhook 重放 | 90 秒幂等窗口 + secret 校验 |

## 4. P3：行为回流（听得越多越准）

### 4.1 目标

音箱播完后，自动把 `quickSkip / next / complete / play80` 写回画像兴趣模型，按抖歌长期层 ×0.3 演进。

### 4.2 实现约束

- 只轮询 miot `GET /player/status`，间隔 `pollIntervalMs`（默认 2500ms，可配 2000–5000）
- 每首歌维护状态机：`seen → playing → ended/skipped`，每首歌每种行为**只记一次**
- 判定规则：
  - 播放时长 < 15 秒或 < 10% → `quickSkip`（-10）
  - 播放进度 ≥ 90% → `complete`（+5）
  - 切歌时上一首不足 90% 且 > 15 秒 → `next`（-1）
  - 单曲重复播放 ≥ 2 次 → `repeat`（+8，每次会话最多一次）
- 写回维度：`artists / albums / genres / styles / languages / decades / songs / formats / types / durationBuckets / folders`
- 长期层：`longTerm = longTerm*0.7 + evidence*0.3`
- 历史：`history` 上限 500，去重最近 20 首不再推荐（可在配置关闭）
- 轮询只在「本插件发起的播放」期间运行，播完 2 分钟无变化自动停，避免常驻

### 4.3 P3 验收

- [ ] 手动停播 10 秒内 → 画像出现 quickSkip 证据
- [ ] 完整听完 → complete 证据 +1
- [ ] 同一首歌不重复计数
- [ ] 停播后 2 分钟轮询自动停止
- [ ] 页面「画像看板」显示证据条数、Top 歌手/标签、置信度
- [ ] 自测覆盖状态机与阈值
- [ ] 发布 v0.4.0

## 5. P4：设备与画像绑定 + 看板

- `device_id → 默认画像` 映射；同一句话在不同房间播不同画像
- 设备名以房间名为前缀展示，不参与匹配
- 初始映射（待用户确认）：二楼客厅→「我」、一楼客厅→「老妈」、阳台房→「老妹」
- 画像看板：Top 歌手/流派/风格/语种/年代、证据数、置信度、最近 7 天行为曲线
- 音箱状态卡：在线/离线、当前歌曲、音量
- 验收：对二楼说「播放推荐」得到「我」，对一楼说得到「老妈」；看板数据与画像一致；发布 v0.5.0

## 6. P5：多账号日推（可选）

- 改造对象是 `ncm-daily`（**不是本插件**）：多账号扫码/验证码登录、每账号独立日推歌单
- 与画像的耦合方式二选一（由用户拍板）：
  - 松耦合：画像绑定 ncm-daily 生成的歌单名，作为「喜欢来源」种子
  - 紧耦合：ncm-daily 通过 `songloft.comm.call` 把种子推给 personal-radio
- 本插件只增加「画像 → 外部歌单名」绑定字段，不改 ncm-daily 仓库结构
- 验收：两个账号各自日推互不串；画像可绑定任一账号歌单；发布 v0.6.0（personal-radio）与对应 ncm-daily 版本

## 7. 升级点清单（按优先级）

1. **标签准确度**：AI 批量二次复核（同一首歌两次标注不一致则丢弃）、按歌手/专辑投票纠偏、覆盖率 <80% 时提示补跑
2. **推荐质量**：负反馈闭环（quickSkip 强化）、冷启动用歌单/收藏做种子、每画像独立探索率
3. **多来源喜欢**：画像绑定多个歌单（「收藏」+「蔡贤权喜欢的音乐」），替代全局收藏开关
4. **可解释性**：推荐理由分维度展示（歌手/标签/收藏/手动），支持「不想听这首」临时屏蔽 7 天
5. **性能**：曲库 >1000 时增量打分缓存；AI 打标只处理新增与低置信度
6. **可观测**：hook 调用日志、成功率、miot 延迟、AI 成本估算（tokens/次）
7. **多设备**：device→profile 映射、房间前缀、并行播放互斥
8. **权限最小化**：hook 只读必要字段；诊断导出默认脱敏

## 8. 数据模型（持续更新）

| key | 内容 |
|---|---|
| `personalRadio.config` | 全局配置（含 P2 桥接字段） |
| `personalRadio.profiles` | 画像列表 |
| `personalRadio.profile.{id}.interest` | 12 维兴趣模型（长期层/短期层/证据数） |
| `personalRadio.profile.{id}.pool` | 推荐池 |
| `personalRadio.profile.{id}.history` | 播放历史（上限 500） |
| `personalRadio.profile.{id}.manual` | 手动画像（歌手/标签权重） |
| `personalRadio.singerTags` | 歌手标签库 |
| `personalRadio.songTags` | 歌曲级四维标签 |
| `personalRadio.aiProgress` | AI 补全进度 |
| `personalRadio.favorites` | 收藏歌单缓存 |
| `personalRadio.hookCalls` | P2 新增：最近 20 次 hook 调用（脱敏） |

## 9. 新会话开工模板（复制给下一个会话）

> 你负责 `Cxquang/songloft-personal-radio` 插件的 **P2 语音桥接**。先读仓库根目录 `ROADMAP.md` 与 `README.md`，严格按第 3 节实现；只改本仓库，不改 miot/ncm-daily/ncmqr。开工第一步：实测 `publicPaths` 挂载 URL、`songloft.plugin.getToken()` 是否存在、miot 的 account_id/device_id 来源，把结果写进 `ROADMAP.md` 第 1 节再动代码。完成后跑 `npm run verify` 与 `npm run build`，汇报验收项，等我确认再发布。

## 10. 发布流程（每个阶段相同）

1. 升 `package.json` / `plugin.json` 版本，更新 `download_url`
2. `npm run verify` 全绿
3. `npm run build`
4. 提交推送 `main`
5. GitHub Release `v{version}`，上传 `Release/personal-radio-v{version}.jsplugin.zip`
6. 验证 `registry.json` 与 `plugin.json` 可读（国内直连不通常用代理）
7. 在 Songloft 插件市场执行更新并做真机验收