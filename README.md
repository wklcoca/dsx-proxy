# dsx-proxy

把 **DeepSeek 网页版**包装成 **OpenAI 兼容接口**的本地反向代理。单个 Node 进程、**零第三方依赖**，
支持流式输出、思考内容（reasoning）、工具调用（tool calls），可以跑在电脑上，也可以跑在
Android 的 PRoot 里给手机上的 AI 客户端用。

> 这不是官方 API。它复刻的是网页端自己的请求（PoW 挑战、会话增量推送），
> 因此**需要你自己的网页版登录 token**，并且只适合个人自用。见文末「免责声明」。

```
客户端（OpenAI SDK / 任意支持自定义 base_url 的 App）
        │  POST /v1/chat/completions
        ▼
   dsx-proxy  ──►  chat.deepseek.com（网页版接口，带 PoW + 会话复用）
```

---

## 为什么需要它

DeepSeek 官方 API 和网页版是两套东西：网页版有免费额度、有 `deepseek-reasoner`，
但**没有公开 API**，而且服务端只认网页端的请求格式（SSE 增量补丁、PoW 挑战头）。
这个代理把两者对齐，让"能用网页版的人"也能被 OpenAI 生态的客户端直接使用。

实现中花力气最多的三个地方，也是这个仓库存在的主要理由：

1. **增量会话复用**：网页端按会话计费/限量，每次全量重推既慢又容易触发 429。
   代理会记住"上次推到哪里"，只发差量（含被改写的头部回贴），并统计流量预算。
2. **工具调用**：网页版模型不走 OpenAI 的 `tool_calls`，而是吐 `DSML` / `<invoke>` /
   裸 JSON 等各种方言。代理要把这些解析成标准 `tool_calls`，同时保证**协议标记绝不漏进正文**。
3. **容错**：模型把工具名写错、标签没闭合、JSON 被截断都是常态。
   代理做名称归一化、残缺调用抢救、围栏保护——**宁可多执行一次可纠正的错误调用，也不静默丢内容**。

---

## 快速开始

```bash
# 需要 Node.js >= 18（用到全局 fetch）
node -v

cp config.example.json config.json
node server.js
```

打开 <http://127.0.0.1:8787/>，按页面提示粘贴网页版 token：

- 浏览器登录 <https://chat.deepseek.com>，F12 → Console 执行：
  `JSON.parse(localStorage.getItem("userToken")).value`
- 或者从 Network 里任意请求的 `authorization` 头复制，去掉 `Bearer ` 前缀

然后就可以当 OpenAI 用：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

Python：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
print(client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "用一句话解释快速排序"}],
).choices[0].message.content)
```

`api_key` 传什么都行（除非你在 config 里设了 `apiKey` 来给自己的代理加一道门）。

---

## 配置

全部字段都在 `config.json`，也可以用 `DS_TOKEN` / `DS_PROXY_CONFIG` / `DS_PROXY_STATE` /
`DS_PROXY_LOG` 环境变量覆盖关键项。**`config.json` 里有 token，已在 `.gitignore` 里，别提交。**

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | 监听地址。给手机用时可以设 `0.0.0.0` |
| `token` | `""` | 网页版 token，**唯一的必填项** |
| `defaultModel` | `deepseek-chat` | 客户端没传 model 时用 |
| `sessionReuse` | `true` | 是否复用上游会话（强烈建议开） |
| `stripProtocolResidue` | `true` | 把协议标记从正文里洗掉。**客户端自己会解析这些标记时设 `false`**，否则它会看不到原始标记 |
| `reuseMatchMode` | `anywhere` | `anywhere`：锚点在上下文中任意位置匹配；`head`：退回"已存尾部==本次头部"的老行为 |
| `reusePrependMaxChars` | `60000` | 头部被改写时，最多回贴多少字符的"被改写的头" |
| `maxContextChars` | `900000` | 单次**全量重推**的正文上限，超了按最新消息截断 |
| `maxSessionChars` | `4000000` | 同一上游会话**累计推送**字符预算（是流量，不是上下文长度） |
| `maxTurnsPerSession` | `400` | 每 N 轮强制换新上游会话 |
| `sessionTtlMs` | `21600000` | 会话 6 小时不用就回收 |
| `minRequestGapMs` | `3000` | 两次上游请求的最小间隔，避免 429 |
| `requestTimeoutMs` | `300000` | 单次上游请求超时 |
| `wasmCachePath` | `""` | PoW 用的 sha3 wasm 缓存路径，留空则放临时目录 |

---

## 工具调用是怎么处理的

网页版模型不会老老实实吐 OpenAI 的 JSON，常见形态有：

| 形态 | 例子 |
|---|---|
| DSML（上游原生） | `<\|DSML\| invoke name="x">…<\|DSML\| parameter name="k">v` |
| 小写方言 | `<tool_abc name="x"><param name="k">v</param></tool_abc>` |
| XML 变体 | `<invoke name="x"><parameter name="k">v</parameter></invoke>` |
| 裸 JSON | `{"name":"x","arguments":{...}}` |
| 以上任何一种的**残缺版** | 没有闭合、甚至没有 `>` |

代理的处理顺序（`lib/tools.js`）：

1. **只在非围栏段处理**——``` 代码块里的例子是示例，既不执行也不删。
2. 依次尝试标准标签、DSML、XML 方言、裸 JSON。
3. **工具名归一化**：`bash` / `Super_Admin:Bash` / `super-admin.bash` 都能对上声明表里的 `super_admin:bash`
   （精确 → 归一化 → 唯一后缀）。
4. **残缺调用抢救**：`name="x"` 后面跟着 JSON 参数、但标签没写完的，还原成真正的调用。
5. **最后才清理**：认不出来又不像调用的标记才删除，并做括号配平兜底。

设计取向：**漏掉一次调用 = 用户看到"AI 突然不说话了"；多认一次 = 客户端回一个"未知工具"错误，
模型自己就能纠正。** 所以宁可偏向前者。

`npm test` 里有对应的回归用例（方言解析、名称容错、残缺抢救、围栏保护、正文保留）。

### 抢救之后还会"告诉模型它错了"

只抢救不纠正有个副作用：**我们照单全收，模型就认为那个格式是对的**，久了会一直用错格式。
所以代理会统计每一轮用错格式的种类（`dialect` / `renamed` / `salvaged`），
在**下一轮**的系统提示里追加一段一次性的纠正说明：

```
# 工具调用格式纠正

你上一轮的工具调用格式不规范：标签没有闭合或缺少 `>`（残缺的工具调用）；工具名与声明不完全一致
本轮已按你的意图代你修正，但请**从现在起严格使用唯一的标准格式**：

<tool_call>{"name":"工具名","arguments":{...}}</tool_call>

要求：
1. 工具名必须与工具声明逐字一致（不要缩写、不要改大小写、不要省略命名空间）。
2. 一个调用一个 `<tool_call>` 块，必须完整闭合；不要使用 DSML、`<invoke>`、`<parameter>` 等其他写法。
3. 不要把这些标记写进正文或代码块里。
```

只发一次（下一轮没再犯错就清掉），避免变成每轮都念的噪音。日志里能看到
`event=format_nudge kinds=salvaged+renamed times=1` 和每轮的 `recover=salvaged+dialect`。

### 正文清理是通用的，不是给某个客户端定制的

`<||DSML|| invoke …` 这类标记漏进 `content` 这件事**与具体客户端无关**：几乎所有
OpenAI 兼容客户端都直接把 `content` 当 markdown 渲染，拿到协议标记就会原样显示给用户。
（我们最初是在 Operit 里发现这个现象的，但清理逻辑本身对任何客户端都适用。）

反过来说，如果你的客户端**自己**会解析这些方言，被我们洗掉反而看不到——
那就把 `stripProtocolResidue` 设成 `false`：调用仍然会被解析成标准 `tool_calls`，
只是正文里保留原始标记。

---

## 会话复用（为什么它省流量）

网页版按会话累计，重复推送整段上下文既慢又容易 429。代理的做法：

- 每次请求把消息切成"段"并算哈希，存进 `state.json`；
- 下次请求先找**已存段的尾部**在本次上下文里的位置（`anywhere` 模式允许锚点出现在任意位置）；
- 只把锚点之后的内容发给上游；
- 如果客户端把历史**改写了**（常见于摘要/压缩），把"被改写的头"回贴进本次请求（有字符上限）。

日志里能看到它有没有生效：

```
id=chatcmpl-… mode=reuse stream=true prompt=876 think=0 content=133 tools=1
   reason=tool_calls match=164@0 prepend=0 turns=48
id=chatcmpl-… mode=fresh stream=false prompt=165 … n=1 trunc=0
```

- `mode=reuse` 命中复用；`match=N@off` 是锚点长度与位置，`prepend` 是回贴字符数，`turns` 是本会话第几轮
- `event=reuse_miss reason=no-match|capped` 说明没复用上，原因直接写在日志里
- `raw=` 清洗前长度、`stripped=` 被剥掉的字符数；`empty=1 rawHead="…"` 表示**上游有输出但被解析层吃干净了**——
  排查"模型不说话"时先看这个字段

---

## 部署

### 电脑 / 服务器（systemd）

```ini
# /etc/systemd/system/dsx-proxy.service
[Unit]
Description=dsx-proxy
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/dsx-proxy
ExecStart=/usr/bin/node /opt/dsx-proxy/server.js
Restart=always
RestartSec=5
User=dsx

[Install]
WantedBy=multi-user.target
```

### Android（PRoot）

`scripts/dsx-daemon.sh` 是一个不依赖 systemd 的守护脚本：每 15 秒探活，挂了自动拉起，
日志超 5 MB 自动截断。把它和仓库放进 PRoot 里（例如 `/opt/dsx`），然后：

```sh
sh /path/to/dsx-daemon.sh --daemon &   # 后台守护
sh /path/to/dsx-daemon.sh --status     # 看状态和最近日志
```

脚本会自己找 `node`，也支持用 `DSX_PORT` / `DSX_LOG` / `DSX_INTERVAL` 覆盖默认值。

---

## 接口

| 路径 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容，支持 `stream`、`tools`、`tool_choice`、`reasoning_content` |
| `GET /v1/models` | 返回可用模型列表 |
| `GET /health` | `{"ok":true,"hasToken":…,"sessions":…,"uptime":…}` |
| `GET /` | 网页控制台：导入 token、看状态和最近日志 |

`usage` 里的 `prompt_tokens` 按**整段上下文**估算上报，而不是只报本次增量——
否则客户端会以为上下文很小，永远不触发它自己的压缩。

---

## 已知限制

- 依赖网页端协议，**上游一改就可能失效**（PoW、SSE 补丁格式、字段名都在变）；
- 单账号、单并发更稳；多路并发容易触发频率限制；
- 不能替代官方 API：没有 SLA，也不保证模型版本；
- `deepseek-reasoner` 的思考内容通过 `reasoning_content` 返回，部分客户端不认这个字段。

---

## 免责声明

本项目仅用于**个人学习与自用**，通过你自己的网页版登录态访问你自己的会话。
请遵守 DeepSeek 的服务条款与当地法律，不要用于商业转售、批量爬取或绕过配额。
仓库里**不包含任何 token / 密钥**，`config.json`、`state.json`、`*.log` 都已被 `.gitignore` 排除。
由此产生的任何后果由使用者自行承担。

## License

MIT
