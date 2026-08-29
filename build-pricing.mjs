#!/usr/bin/env node
/**
 * build-pricing.mjs —— 从上游 LiteLLM 价格数据生成 sub2api 可用的价格源
 *
 * 用法：
 *   node build-pricing.mjs
 *
 * 行为：
 *   1. 拉取上游 LiteLLM 格式价格 JSON（顶层为 {原始key: 条目} 扁平结构）
 *   2. 按 prefixes.json 采集，每一项支持 `*` 通配符（匹配任意字符串）：
 *      - prefixes 列表顺序 = 优先级；项不含 "/" 视为厂商整厂（自动按
 *        `<项>/` 匹配，如 "zai" 采集 zai/glm-5.3）；项含 "/" 视为完整模式
 *        （如 "zai/glm-5*" 只采 zai 的 glm-5 系）
 *      - alwaysPrefixes：无条件直采，按项开头匹配（如 "claude-"、"o3"），
 *        优先级低于 prefixes
 *   3. 新 key = 原始 key 最后一个 "/" 之后的裸名，统一转小写；
 *      条目数据逐字段原样照抄，不做任何字段级加工
 *   4. 序列化前递归排序所有层级 key，保证相同输入产出字节级相同的输出
 *   5. 生成 sha256sum 风格校验文件
 *
 * 失败（网络错误 / 非 200 / JSON 解析失败 / 配置缺失）时退出码非 0，
 * 不覆盖已有产物（全程先在内存构建，落盘走临时文件 + 原子改名）。
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 常量 ----------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(SCRIPT_DIR, 'prefixes.json');
const UPSTREAM_URL = 'https://ai.cloudprice.net/api/v1/litellm_model_prices.json';
const OUT_JSON_NAME = 'litellm_model_prices.json';
const OUT_SHA256_NAME = 'litellm_model_prices.sha256';

/** sub2api 认可的价格字段：条目至少含其一，否则该条目会被丢弃 */
const PRICE_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'output_cost_per_image',
  'output_cost_per_image_token',
  'input_cost_per_image_token',
];

/** 已知非模型条目（LiteLLM 用 sample_* key 存示例数据，不是模型） */
const NON_MODEL_KEYS = new Set(['sample_spec']);
const NON_MODEL_KEY_PREFIX = 'sample_';

/** alwaysPrefixes 直采条目的优先级（数值上低于 prefixes 的所有下标） */
const ALWAYS_PRIORITY = Number.MAX_SAFE_INTEGER;

/** 拉取超时与重试 */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

// ---------- 工具函数 ----------

/** 递归排序对象所有层级的 key（数组保持元素顺序，只排对象 key） */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把支持 `*` 通配符的模式编译成"开头匹配"正则（只支持 *，其余字符按字面量） */
function compileStartPattern(pattern) {
  let source = '^';
  for (const ch of pattern) {
    if (ch === '*') {
      source += '[\\s\\S]*';
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(source);
}

// ---------- 各阶段实现 ----------

/** 读取并校验 prefixes.json */
async function loadConfig() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (error) {
    throw new Error(`无法读取配置文件 ${CONFIG_PATH}：${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件 ${CONFIG_PATH} 不是合法 JSON：${error.message}`);
  }

  const toStringList = (value, field) => {
    if (!Array.isArray(value)) {
      throw new Error(`配置文件 ${CONFIG_PATH} 缺少数组字段 "${field}"`);
    }
    const list = value.filter((item) => typeof item === 'string' && item.length > 0);
    if (list.length === 0) {
      throw new Error(`配置文件 ${CONFIG_PATH} 的 "${field}" 为空或无有效项`);
    }
    return list;
  };

  const prefixes = toStringList(parsed.prefixes, 'prefixes');
  const alwaysPrefixes = toStringList(parsed.alwaysPrefixes, 'alwaysPrefixes');

  // 编译成匹配规则：prefixes 不含 "/" 的项自动补 "/"（厂商整厂），
  // 含 "/" 的项按完整模式匹配；alwaysPrefixes 按项开头匹配
  const rules = [
    ...prefixes.map((item, index) => ({
      kind: 'prefix',
      display: item,
      priority: index,
      regex: compileStartPattern(item.includes('/') ? item : `${item}/`),
    })),
    ...alwaysPrefixes.map((item) => ({
      kind: 'always',
      display: item,
      priority: ALWAYS_PRIORITY,
      regex: compileStartPattern(item),
    })),
  ];

  return { rules };
}

/** 拉取上游数据（重试 MAX_ATTEMPTS 次），任何失败都抛错，由 main 统一退出 */
async function fetchUpstream(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json', 'user-agent': 'build-pricing/1.0' },
      });
      if (!response.ok) {
        throw new Error(`上游返回 HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        console.error(`第 ${attempt} 次拉取失败：${error.message}，${attempt} 秒后重试`);
        await sleep(attempt * 1000);
      }
    }
  }
  throw new Error(`拉取上游 ${url} 失败（共尝试 ${MAX_ATTEMPTS} 次）：${lastError.message}`);
}

/**
 * 判断原始 key 命中的第一条规则（规则已按优先级排序：prefixes 下标在前，
 * alwaysPrefixes 统一最低）。命中规则的 priority 用于同名冲突裁决，
 * 同优先级内先遍历到的原始 key 胜出（同一份上游数据结果确定）。
 */
function classifyKey(originalKey, rules) {
  for (const rule of rules) {
    if (rule.regex.test(originalKey)) {
      return rule;
    }
  }
  return null;
}

/** 条目是否至少含一个 sub2api 认可的价格字段 */
function hasAnyPriceField(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  return PRICE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(entry, field));
}

/**
 * 采集 + 转换 + 过滤 + 冲突处理。
 * 条目数据只按引用照抄，不做任何字段级加工。
 */
function buildPricing(upstream, rules) {
  // 裸名 -> { originalKey, entry, priority }
  const byBareName = new Map();
  const stats = {
    directByRule: new Map(), // alwaysPrefixes 项 -> 采集条数
    prefixByRule: new Map(), // prefixes 项 -> 采集条数
    nonModelDropped: 0,
    noPriceDropped: 0,
    conflictDropped: 0,
  };

  for (const [originalKey, entry] of Object.entries(upstream)) {
    // 非模型条目（如 sample_spec）
    if (NON_MODEL_KEYS.has(originalKey) || originalKey.startsWith(NON_MODEL_KEY_PREFIX)) {
      stats.nonModelDropped++;
      continue;
    }

    const matched = classifyKey(originalKey, rules);
    if (!matched) continue;

    // 无任何价格字段的条目丢弃（sub2api 侧也会丢，此处提前减小文件体积）
    if (!hasAnyPriceField(entry)) {
      stats.noPriceDropped++;
      continue;
    }

    // 裸名 = 最后一个 "/" 之后的部分，统一转小写
    const bareName = originalKey.slice(originalKey.lastIndexOf('/') + 1).toLowerCase();
    if (bareName === '') {
      console.error(`warning: 原始 key "${originalKey}" 裸名为空，跳过`);
      continue;
    }

    if (matched.kind === 'always') {
      stats.directByRule.set(matched.display, (stats.directByRule.get(matched.display) ?? 0) + 1);
    } else {
      stats.prefixByRule.set(matched.display, (stats.prefixByRule.get(matched.display) ?? 0) + 1);
    }

    const existing = byBareName.get(bareName);
    if (existing === undefined || matched.priority < existing.priority) {
      if (existing !== undefined) {
        // 新条目优先级更高：替换，旧条目计入冲突丢弃
        stats.conflictDropped++;
        console.error(
          `warning: 裸名 "${bareName}" 冲突：保留 "${originalKey}"（优先级更高），丢弃 "${existing.originalKey}"`
        );
      }
      byBareName.set(bareName, { originalKey, entry, priority: matched.priority });
    } else {
      // 已有条目优先级更高或相同（相同则先到者胜）：丢弃新条目
      stats.conflictDropped++;
      console.error(
        `warning: 裸名 "${bareName}" 冲突：保留 "${existing.originalKey}"，丢弃 "${originalKey}"`
      );
    }
  }

  const result = {};
  for (const [bareName, { entry }] of byBareName) {
    result[bareName] = entry;
  }
  return { result, stats };
}

// ---------- 主流程 ----------

async function main() {
  const { rules } = await loadConfig();

  const upstream = await fetchUpstream(UPSTREAM_URL);
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) {
    throw new Error('上游数据顶层不是 {模型名: 条目} 结构');
  }

  const { result, stats } = buildPricing(upstream, rules);

  // 序列化：递归排序所有层级 key，2 空格缩进，末尾换行（UTF-8 无 BOM）
  const jsonText = `${JSON.stringify(sortKeysDeep(result), null, 2)}\n`;
  const sha256Hex = createHash('sha256').update(jsonText, 'utf8').digest('hex');
  const sha256Text = `${sha256Hex}  ${OUT_JSON_NAME}\n`;

  // 先写临时文件再原子改名：失败不会留下半截产物，也不会破坏已有产物
  const jsonTmpPath = join(SCRIPT_DIR, `.${OUT_JSON_NAME}.tmp`);
  const shaTmpPath = join(SCRIPT_DIR, `.${OUT_SHA256_NAME}.tmp`);
  await writeFile(jsonTmpPath, jsonText, 'utf8');
  await writeFile(shaTmpPath, sha256Text, 'utf8');
  await rename(jsonTmpPath, join(SCRIPT_DIR, OUT_JSON_NAME));
  await rename(shaTmpPath, join(SCRIPT_DIR, OUT_SHA256_NAME));

  // 打印统计（按配置项分组，与 prefixes.json 中的书写一致）
  const prefixRules = rules.filter((rule) => rule.kind === 'prefix');
  const alwaysRules = rules.filter((rule) => rule.kind === 'always');
  const directTotal = [...stats.directByRule.values()].reduce((sum, n) => sum + n, 0);
  const directDetail = [...stats.directByRule.entries()].map(([p, n]) => `${p}: ${n}`).join(', ');
  const prefixTotal = [...stats.prefixByRule.values()].reduce((sum, n) => sum + n, 0);

  console.log('统计：');
  console.log(`  直采条数（alwaysPrefixes）: ${directTotal}${directDetail ? `（${directDetail}）` : ''}`);
  console.log('  前缀采集条数（按配置项分组）:');
  for (const rule of prefixRules) {
    console.log(`    ${rule.display}: ${stats.prefixByRule.get(rule.display) ?? 0}`);
  }
  console.log(`  前缀采集合计: ${prefixTotal}`);
  console.log(`  非模型条目丢弃: ${stats.nonModelDropped}`);
  console.log(`  无价格字段丢弃: ${stats.noPriceDropped}`);
  console.log(`  冲突丢弃数: ${stats.conflictDropped}`);
  console.log(`  最终条数: ${Object.keys(result).length}`);
  console.log(`  sha256: ${sha256Hex}`);
  console.log('产物已生成：');
  console.log(`  ${join(SCRIPT_DIR, OUT_JSON_NAME)}`);
  console.log(`  ${join(SCRIPT_DIR, OUT_SHA256_NAME)}`);
}

main().catch((error) => {
  console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
