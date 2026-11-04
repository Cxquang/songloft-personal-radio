# songloft-personal-radio（个人电台）

Songloft 插件：按**多人画像**自动演进的个性化电台推荐引擎。给家人各建一份画像，说「播放老妈喜欢的」就自动从曲库挑她那一套，听得越多越准。

> ⚠️ **P1 + v0.2.1（AI 标签补全 + 可观测性增强）已完成，自测 115 项全绿；P2 语音桥接 + P3 行为回流待接入。** 详见下文「后续阶段」。

## 功能

### P1（基础引擎）

- **多画像存储**：默认画像「我」，可增删改（老妈、老妹……），各画像兴趣模型、推荐池、历史、手动画像完全隔离
- **打分引擎（移植抖歌内核）**：
  - 12 维打分：歌手 18 / 歌曲 15 / 流派 12 / 风格 10 / 语种 8 / 专辑 7 / 年代 7 / 年份 3 / 时长 3 / 目录 3 / 类型 2 / 格式 2
  - 时间衰减：`score × 0.992^ageDays`（封顶 365 天）
  - 置信度：`0.45 + 0.55 × (1 - e^(-count/4))`——证据少的时候保守，证据多了才自信
  - 长期层 × 0.3（P3 行为回流时写入；P1 可手动打标签正/负权重来演进画像）
  - 探索比例：证据 <10 → 35%，<60 → 22%，否则 15%
  - 多样性约束：同歌手 ≤25%、同流派 ≤45%、同语种 ≤65%、同年代 ≤55%
  - 稳定抖动：FNV-1a hash `stableJitter(songId + sessionId)`，同一天排序稳定但有微小扰动
- **推荐池**：容量 100、取批 20、收藏占比 ≤20%；取空自动补充，支持回池
- **歌手 → 标签映射**（绕开宿主无 genre/language/year 字段的限制）：
  - 给歌手打「华语 / 粤语 / 民谣 / 摇滚 / 2000s」这类标签
  - 画像里设「民谣 +0.8」「粤语 -0.5」就能改变排序
- **手动画像**：歌手 ±1.0 权重（永久压制或永久推升）+ 歌手标签偏好
- **收藏同步**：自动识别收藏歌单、缓存歌单 ids；每画像可独立选择是否纳入收藏歌（整体开关，不做逐首归属）
- **页面**：画像 Tabs、今日推荐（含 score 明细 + reason）、画像编辑、手动画像、歌手标签库、引擎设置、运行日志
- **自测**：`node scripts/verify.mjs` 基础项全绿（v0.2.1 起共 115 项）

### v0.2.0（AI 标签补全）

解决「曲库没有流派/风格/语种/年代、不可能逐首手打标签」的问题：

- **四级标签体系**：流派（民谣/电子/另类独立/轻音乐/综艺/影视原声/ACG）、风格（流行/摇滚/民谣/爵士/说唱/古典/古风……）、语种（华语/欧美/日语/韩语/粤语）、年代（1950s–2020s）
- **歌曲级标签优先**：`personalRadio.songTags` 存每首歌的四维标签，优先于歌手级标签；手动标注默认 `locked`，AI 不会覆盖
- **零成本先补语种**：按 Unicode 字符范围识别（谚文→韩语、假名→日语、汉字→华语、拉丁→欧美）
- **AI 批量打标（OpenAI 兼容）**：支持 DeepSeek / 硅基流动 / 智谱 / 百炼 / 火山方舟 / Kimi / MiniMax / 混元 / 自定义；BaseURL 自动归一、Bearer 鉴权、自定义请求头（禁止覆盖 Authorization）、超时、JSON 模式、批量大小、并发、最低置信度、单次上限
- **准确度约束**：提示词锁定标签枚举 + 无法判断填 null + 置信度阈值 + 只接受枚举内值 + 锁定项跳过 + 语种本地判定
- **页面上限管理**：AI 设置卡（检测连接与获取模型、开始/停止补全、进度与覆盖率）、标签云（点选默认 +0.6、可编辑权重）、推荐列表每首歌的「标签」弹层（四组 chips 手动改标）
- **自测**：89 项，含 mock AI `/models` 与 `/chat/completions` 全流程

### v0.2.1（可观测性增强）

- **覆盖率按全库统计**：显示全库/本地/网络/待补全/已锁定/宿主自带流派与年份；六个覆盖率格子可点击，直接筛选下方明细
- **歌曲标签明细表**：按关键词、维度（有流派/风格/语种/年代）、状态（完整/部分缺失/未标注/待补全/锁定）、来源（AI/手动/本地预填）、类型（本地/网络/电台）筛选并分页；每行展示四维标签与缺失维度，可直接编辑
- **AI 逐首结果**：每次任务记录每首歌的写入/跳过/失败原因（上限 300 条），日志增加批次级写入/跳过统计
- **默认候选改为全部歌曲（含本地）**：旧配置自动一次性迁移；`candidateSource` 仍可切回 `remote`
- **自测**：115 项，新增全库统计、待补全口径、标签明细筛选/分页、逐首结果断言

### 后续阶段

- **P2（待开工）**：`/public/hook` 免 JWT 端点 + miot 对话 Webhook 接入，口令别名最长匹配（「播放老妈喜欢的」→ mom 画像），自动建歌单「{画像名}-推荐」，调 miot `POST /player/play` 出声
- **P3**：轮询 `/player/status`（每 2–3 秒），判定 quickSkip / next / complete 并写回画像——到这一步「听得越多越准」才真正生效
- **P4**：画像看板（Top 歌手/标签/置信度/样本数）+ `device_id → 默认画像` 映射（客厅音箱默认「我」、卧室默认「老妈」）
- **P5（可选）**：每画像一份独立网易云日推，做冷启动种子

## 算法来源

打分内核**移植自 [charce526/songloft-music-feed](https://github.com/charce526/songloft-music-feed)** v1.4.7（Apache-2.0 许可）。未 fork，只移植纯函数段（时间衰减、置信度、特征提取、打分、罚分/探索/哈希、多样性约束），宿主依赖全部改写为 Songloft JS 插件 API。

核心参数沿用抖歌实测值：

| 参数 | 值 | 说明 |
|---|---|---|
| 时间衰减系数 | 0.992 / 天 | 旧兴趣自然遗忘 |
| 置信度 | `0.45 + 0.55×(1-e^(-c/4))` | 证据少的时候保守，4 个样本就接近 0.75 |
| 长期层权重 | ×0.3 | 避免单次行为把画像带歪 |
| 池容量 | 100 | 预筛一批候选，打分时不必每次全量扫 |
| 取批 | 20 | 每次播放的歌单长度 |
| 收藏占比上限 | 20% | 避免「全是收藏」导致没惊喜 |
| 探索比例 | 15–35% | 证据越少越愿意探索 |
| 同歌手上限 | 25% | 避免一张专辑连播 |

行为权重表（抖歌 `BEHAVIOR_WEIGHTS`，P3 回流时使用）：

| 行为 | 权重 |
|---|---|
| complete | +5 |
| favorite | +12 |
| like | +7 |
| repeat | +8 |
| play80 | +3 |
| search | +20 |
| next | -1 |
| skip | -2 |
| quickSkip | -10 |
| dislike | -14 |

## 架构

```
小爱音箱
  │ 「播放老妈喜欢的」
  ▼
miot 插件（不改）── 对话 Webhook POST ──►
  │                                   personal-radio /public/hook（免 JWT + key 校验）
  │                                       ① 取 question → 别名最长匹配 → profileId
  │                                       ② 打分取 20 首 → 多样性筛选
  │                                       ③ 重建歌单「老妈-推荐」
  │                                       ④ 插件令牌调 miot POST /player/play
  ▼                                       ⑤ 启动行为轮询（每 2–3 秒）
音箱出声 ──────────────────────────────────────────────┘
  │ P3：判定 quickSkip / next / complete
  ▼
写入画像长期兴趣模型（×0.3），画像自动演进
```

P1 阶段不接 miot，打分引擎、画像管理、池、歌手标签库、手动画像全部独立可验证。

## 宿主字段限制

Songloft 宿主歌曲对象**没有 genre / language / year 字段**（只有 `id / type / title / artist / album / duration / url / cover_url / format` 等）。因此：

- 抖歌 12 维里 `genre / style / language / decade / year` 合计约 40 权重在真实曲库里原本为空
- 本插件用**歌手 → 标签映射**来近似：给歌手打标签，画像设偏好，标签命中的歌就有分数加成/压制
- v0.2.0 起改为**歌曲级标签**（AI 批量打标 + 人工纠正 + 锁定保护），歌手级标签仅作兜底；仍不承诺 100% 准确，但可按覆盖率与置信度逐步提升

## 安装

### 方式一：插件源在线安装（推荐）

Songloft Web → 插件市场 → 添加插件源，填入：

```
https://raw.githubusercontent.com/Cxquang/songloft-personal-radio/main/registry.json
```

即可在市场中搜索「个人电台」安装。后续更新时市场会自动检测。

### 方式二：手动上传 zip

从 [GitHub Releases](../../releases) 下载 `personal-radio-v{version}.jsplugin.zip`，Songloft Web → 插件管理 → 上传该 zip。

直链（v0.2.1）：
```
https://github.com/Cxquang/songloft-personal-radio/releases/download/v0.2.1/personal-radio-v0.2.1.jsplugin.zip
```

### 方式三：源码构建

```bash
npm install          # 零依赖（纯 Node builtin），可跳过
npm run build        # 产物 Release/personal-radio-v0.2.1.jsplugin.zip
npm run verify       # 自测 115 项
```

## 配置

插件页「引擎设置」可调整（右侧配置卡）：

| 配置项 | 默认 | 说明 |
|---|---|---|
| 候选来源 | all | `all` 含本地歌；`remote` 只网络歌曲 |
| 池容量 | 100 | 推荐池预筛候选数 |
| 批量 | 20 | 每次取批大小 |
| 探索比例 | 自动（15–35%） | 手动设值覆盖自动逻辑 |
| 手动权重 | 0.6 | 手动画像分在最终分中的占比 |
| 收藏加分 | 12 | 收藏歌的加分（抖歌 favorite 权重） |

AI 标签补全配置（v0.2.0）：\n\n| 配置项 | 默认 | 说明 |\n|---|---|---|\n| 启用 AI 标签 | false | 关闭时只用本地语种识别与手动标签 |\n| 服务商 / API 地址 | DeepSeek 官方 | OpenAI 兼容 BaseURL，自动补 `/v1` 并归一 |\n| API 密钥 | 空 | 页面显示「已保存」后留空保存不会清空旧密钥 |\n| 模型 | deepseek-chat | 可从 `/models` 拉取，也可手工填写 |\n| 自定义请求头 | {} | JSON 对象；禁止覆盖 Authorization 等内置头 |\n| 超时 | 30 秒 | 5–120 秒 |\n| 每批歌曲数 | 20 | 5–50；越大越快但越容易截断 |\n| 最低置信度 | 0.7 | AI 自评低于该值直接丢弃 |\n| 单次上限 | 0 | 0 = 不限制；用于先小批量试跑 |\n| JSON 输出 | 开 | 服务商不支持时可关闭，改为解析文本 JSON |\n| 先本地识别语种 | 开 | 零成本，减少 AI 调用 |\n\n> P2 还需要配置「桥接开关」「hook 密钥」「miot 地址」；当前版本留空不生效。

## 数据模型

全部存储以 `personalRadio.` 为前缀，按画像隔离：

| key | 内容 |
|---|---|
| `personalRadio.config` | 全局配置 |
| `personalRadio.profiles` | 画像列表（id / 名称 / 别名 / 是否默认 / useFavorites） |
| `personalRadio.profile.{id}.interest` | 该画像长期兴趣模型 |
| `personalRadio.profile.{id}.pool` | 该画像推荐池 |
| `personalRadio.profile.{id}.history` | 该画像播放历史（上限 500） |
| `personalRadio.profile.{id}.manual` | 该画像手动画像（歌手权重 + 标签偏好） |
| `personalRadio.singerTags` | 歌手标签库 |
| `personalRadio.favorites` | 收藏歌单缓存 |\n| `personalRadio.songTags` | 歌曲级四维标签 `{ g, s, l, d, src, conf, locked, at }` |\n| `personalRadio.aiProgress` | AI 补全任务进度（刷新页面可恢复显示） |

## 自测

```bash
npm run verify
```

mock 16 首（12 首 remote + 4 首 local），收藏 2 首，覆盖：

- 画像 CRUD + 别名唯一 + 默认画像 + 最后一个画像禁止删除
- 候选来源 `all`（16 首，含本地）/ `remote`（12 首）切换
- 手动正权重提升目标歌手 / 负权重压制
- `useFavorites` 开关：false 时收藏分 0，true 时 +12
- 歌手标签映射 → 排序改变
- 两个画像同一批歌 top 不同
- 池：refill → checkout → 自动补 → 回池 → 再取
- API 边界：404 / 400

v0.2.1 起共 115 项通过，新增覆盖：全库统计与待补全口径、标签明细筛选/分页、AI 逐首结果；原有覆盖：标签字典、AI 配置与请求头校验、模型列表、连通性检测、补全任务轮询、覆盖率、单曲标签读写/锁定/删除、AI 重跑不覆盖锁定项。

## 依赖

| 组件 | 说明 |
|---|---|
| Songloft 宿主 | ≥ 2.11.0 |
| Songloft miot 插件 | P2 语音桥接需要；P1 不需要 |
| 抖歌算法 | 移植自 Apache-2.0，非 fork |

## 工作原理

- 打分公式：`最终分 = 自动分 + 手动分 × 0.6 + 收藏加分 + FNV-1a 抖动`
- 自动分：`Σ(该维均值 × 维度权重 × 时间衰减 × 置信度)`
- 手动分：歌手命中 × ±1.0 + 歌手标签偏好 × 对应维度分 × 0.6
- 今天的 sessionId 基于日期 + 画像 id，保证「今日推荐」同一天稳定、跨天自然切换

## 发布新版本流程

1. 改 `package.json` / `src/main.js` / `static/index.html` / `plugin.json` 中的版本号
2. `npm run build` 构建（自动回写 entryHash / zipHash 到 plugin.json）
3. 提交推送；在 GitHub 创建 Release `v{version}` 并附上 `Release/` 下新 zip
4. 插件源 `registry.json` 指向 main 分支 plugin.json，**无需改动**

## License

MIT（算法参考 Apache-2.0，已在代码头部注明来源与裁剪改造）
