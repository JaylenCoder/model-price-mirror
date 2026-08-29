# model-price-mirror

自有 LiteLLM 格式价格源：从上游价格 API 采集数据，生成 [sub2api](https://github.com/Wei-Shaw/sub2api) 可直接使用的价格源 JSON（含 sha256 校验文件），GitHub Actions 每 30 分钟自动更新。

## 直链（sub2api 直接使用）

```
https://raw.githubusercontent.com/JaylenCoder/model-price-mirror/main/litellm_model_prices.json
https://raw.githubusercontent.com/JaylenCoder/model-price-mirror/main/litellm_model_prices.sha256
```

sub2api 侧配置片段：

```yaml
# 价格源直链（JSON）
remote_url: https://raw.githubusercontent.com/JaylenCoder/model-price-mirror/main/litellm_model_prices.json
# sha256 校验文件直链
hash_url: https://raw.githubusercontent.com/JaylenCoder/model-price-mirror/main/litellm_model_prices.sha256
```

sub2api 按 sha256 变化判断是否重新下载。本程序保证相同上游数据产出字节级相同的 JSON，只有上游价格真实变化时才触发重新拉取。

## 产物

| 文件 | 说明 |
| --- | --- |
| `litellm_model_prices.json` | 价格源。顶层直接是 `{模型名: 条目}`，无包装层；key 为去掉厂商前缀的全小写裸名（如 `glm-5.3`、`minimax-m2`）；所有层级 key 递归排序，相同输入产出字节级相同 |
| `litellm_model_prices.sha256` | sha256sum 风格校验文件：`<hex摘要>  litellm_model_prices.json`，`shasum -a 256 -c` / `sha256sum -c` 可校验 |

条目数据从上游**逐字段原样照抄**（不增删字段、不改数值、不换单位）；仅丢弃非模型条目（如 `sample_spec`）和不含任何价格字段的条目。

## 本地运行

要求 Node.js >= 18，零第三方依赖：

```bash
node build-pricing.mjs
```

产物写入脚本所在目录，每次运行覆盖。stdout 打印统计（直采条数、按配置项分组采集条数、冲突丢弃数、最终条数、sha256），冲突明细以 warning 打印到 stderr。

失败（网络错误、非 200、JSON 解析失败、配置缺失）时退出码非 0，**不覆盖已有产物**。

## 采集配置 `prefixes.json`

两个列表的每一项都是一个**前缀模式**，支持 `*` 通配符（匹配任意字符串）。当前配置：

```json
{
  "prefixes": [
    "openrouter/z-ai/glm-5",
    "openrouter/moonshotai/kimi-k",
    "openrouter/qwen/qwen3.7",
    "openrouter/qwen/qwen3.8",
    "openrouter/minimax/minimax-m",
    "openrouter/x-ai/grok-4.",
    "openrouter/deepseek/deepseek-v4-"
  ],
  "alwaysPrefixes": ["claude-", "gpt-"]
}
```

### 匹配规则

- `prefixes` 项**不含 `/`**：视为厂商整厂，按 `<项>/` 开头匹配。如 `"zai"` 采集 `zai/glm-5.3`
- `prefixes` 项**含 `/`**：按完整模式开头匹配（不自动补 `/`），支持多级前缀、可精确到系列：
  - `openrouter/z-ai/glm-5` → 命中 `openrouter/z-ai/glm-5`、`…/glm-5.1`、`…/glm-5.3` 等
  - `dashscope/qwen3.` → 只命中 `qwen3.5`、`qwen3.6` 等点号版本，排除 `qwen3-coder`、`qwen3-next` 等连字符系
  - `zai/glm-5*` → 通配任意后缀，含未来的 `glm-5.4`
- `alwaysPrefixes`：按项开头匹配原始 key 自身（如 `claude-opus-4-5`），优先级低于所有 `prefixes`。`o3`、`o4-mini` 等 OpenAI 模型不带 `gpt-` 前缀，需要的话追加 `"o1"`、`"o3"`、`"o4-"`

### 转换与冲突

- **裸名转换**：采集到的 key 取最后一个 `/` 之后的部分并转小写作为新 key（多级前缀如 `openrouter/z-ai/glm-5.3` 同样取 `glm-5.3`）
- **优先级**：`prefixes` 列表顺序 = 优先级，`alwaysPrefixes` 最低；多个原始 key 产出同一裸名时取优先级最高的一条，被丢弃的原始 key 以 warning 打到 stderr
- 当前配置全部锁定 `openrouter/` 单一渠道，价格口径统一为 OpenRouter 平台价（含平台费率，与官方 API 价不同）

## 自动更新（GitHub Actions）

`.github/workflows/update-pricing.yml`：每 30 分钟（`*/30 * * * *`，UTC）拉取上游 → 生成 → 价格有变化才提交推送，也支持在 [Actions 页](https://github.com/JaylenCoder/model-price-mirror/actions) 手动触发（Run workflow）。

注意 GitHub 的 60 天规则：仓库连续 60 天无真实活动（push、issue 等；`github-actions[bot]` 的提交不算）时，定时任务会被自动禁用，收到 GitHub 邮件后到 Actions 页重新启用即可。

raw 直链有约 5 分钟 CDN 缓存，对 30 分钟更新粒度无影响。

## 修改采集范围

本地改 `prefixes.json` → `node build-pricing.mjs` 验证统计与命中 → 提交推送：

```bash
node build-pricing.mjs
git add prefixes.json litellm_model_prices.json litellm_model_prices.sha256
git commit -m "chore: 调整采集前缀"
git push
```

## 验收自检

```bash
node build-pricing.mjs
# 顶层无包装层、key 全小写无 "/"、glm-5.3 / claude-opus-4-5 / gpt-5.2 / minimax-m2 等存在且与上游逐字段一致
shasum -a 256 -c litellm_model_prices.sha256   # Linux 用 sha256sum -c
# 确定性：连续运行两次，sha256 相同
shasum -a 256 litellm_model_prices.json && node build-pricing.mjs > /dev/null && shasum -a 256 litellm_model_prices.json
```
