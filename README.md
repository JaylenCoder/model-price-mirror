# model-price-mirror

从上游 LiteLLM 格式价格 API（[ai.cloudprice.net](https://ai.cloudprice.net/api/v1/litellm_model_prices.json)）采集数据，
生成 [sub2api](https://github.com/Wei-Shaw/sub2api) 可直接使用的自有价格源 JSON（含 sha256 校验文件）。

## 产物

| 文件 | 说明 |
| --- | --- |
| `litellm_model_prices.json` | 价格源。顶层直接是 `{模型名: 条目}`，无任何包装层；key 为去厂商前缀的全小写裸名（如 `glm-5.3`、`minimax-m2`）；所有层级 key 递归排序，保证相同输入产出字节级相同的输出 |
| `litellm_model_prices.sha256` | sha256sum 风格校验文件：`<hex摘要>  litellm_model_prices.json`，可用 `shasum -a 256 -c` / `sha256sum -c` 校验 |

条目数据从上游**逐字段原样照抄**（不增删字段、不改数值、不换单位）；仅丢弃非模型条目（如 `sample_spec`）和不含任何价格字段的条目。

## 运行

要求 Node.js >= 18（内置 `fetch`），零第三方依赖：

```bash
node build-pricing.mjs
```

产物写入脚本所在目录，每次运行覆盖生成。结束时 stdout 打印统计（直采条数、按前缀分组的采集条数、冲突丢弃数、最终条数、sha256），冲突明细以 warning 打印到 stderr。

失败（网络错误、非 200、JSON 解析失败、配置缺失）时退出码非 0，**不会覆盖已有产物**。

## 采集配置 `prefixes.json`

与脚本同目录，两个列表的每一项都是一个**前缀模式**，支持 `*` 通配符（匹配任意字符串，含空串）：

```json
{
  "prefixes": [
    "zai/glm-5",
    "moonshot/kimi-k",
    "dashscope/qwen3.",
    "minimax",
    "xai/grok-4."
  ],
  "alwaysPrefixes": ["claude-", "gpt-"]
}
```

### prefixes（`<模式>/` 前缀采集）

- 项**不含 `/`**：视为厂商整厂，按 `<项>/` 开头匹配。如 `"minimax"` 采集 `minimax/MiniMax-M2`
- 项**含 `/`**：按完整模式开头匹配（不自动补 `/`），可精确到系列：
  - `zai/glm-5` → 命中 `zai/glm-5`、`zai/glm-5.1`、`zai/glm-5.3`（注意也会命中 `zai/glm-5-code` 这类同前缀条目）
  - `dashscope/qwen3.` → 只命中 `qwen3.5`、`qwen3.6` 等点号版本，排除 `qwen3-coder`、`qwen3-next` 等连字符系
  - `zai/glm-5*` → 通配任意后缀，含未来的 `glm-5.4`
- **列表顺序 = 优先级**：多个模式产出同一裸名时，先配置的胜出，被丢弃的原始 key 以 warning 打到 stderr

### alwaysPrefixes（无条件直采）

按项开头匹配原始 key 自身（支持 `*`），优先级低于所有 `prefixes`。如 `"claude-"`、`"gpt-"`；`o3`、`o4-mini` 等 OpenAI 模型不带 `gpt-` 前缀，需要的话追加 `"o1"`、`"o3"`、`"o4-"`。

### 裸名转换与条目数据

采集到的 key 取最后一个 `/` 之后的部分并转小写作为新 key（多级前缀如 `openrouter/z-ai/glm-5.3` 同样取 `glm-5.3`）；条目数据逐字段原样照抄，不做任何加工。

## 托管为静态文件

sub2api 需要通过可公网访问的直链拉取价格源，任选一种方式：

### 方式一：GitHub 仓库 + Actions 自动更新（推荐）

1. 把本目录推到一个 GitHub 仓库（已附带 `.github/workflows/update-pricing.yml`，每日 UTC 02:30 定时运行并提交产物，也支持手动触发 `workflow_dispatch`）。
2. 使用 raw.githubusercontent.com 直链：

```
https://raw.githubusercontent.com/<用户名>/<仓库名>/main/litellm_model_prices.json
https://raw.githubusercontent.com/<用户名>/<仓库名>/main/litellm_model_prices.sha256
```

### 方式二：任意静态托管

把生成的两个文件传到 nginx / Cloudflare Pages / 对象存储等任意静态服务，确保两个文件可直链访问即可。

## sub2api 侧配置片段

在 sub2api 的模型价格源设置中（字段名以所用版本文档为准）：

```yaml
# 价格源直链（JSON）
remote_url: https://raw.githubusercontent.com/<用户名>/<仓库名>/main/litellm_model_prices.json
# sha256 校验文件直链
hash_url: https://raw.githubusercontent.com/<用户名>/<仓库名>/main/litellm_model_prices.sha256
```

sub2api 按 sha256 变化判断是否重新下载。本程序保证相同上游数据产出字节级相同的 JSON，因此只有上游价格真实变化时才会触发重新拉取。

## 验收自检

```bash
node build-pricing.mjs
# 顶层无包装层、key 全小写无 "/"、glm-5.3 / claude-opus-4-5 / gpt-5.2 / minimax-m2 存在且与上游逐字段一致
shasum -a 256 -c litellm_model_prices.sha256   # Linux 用 sha256sum -c
# 连续运行两次，两次 JSON 的 sha256 相同（确定性）
shasum -a 256 litellm_model_prices.json && node build-pricing.mjs > /dev/null && shasum -a 256 litellm_model_prices.json
```
