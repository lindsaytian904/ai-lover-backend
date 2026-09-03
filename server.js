require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const stickersConfigPath = path.join(__dirname, 'stickersConfig.json');
let stickersConfig = [];
try {
  stickersConfig = JSON.parse(fs.readFileSync(stickersConfigPath, 'utf-8'));
} catch (err) {
  console.error('读取 stickersConfig.json 失败:', err.message);
}

function buildTimeSyncRule() {
  const currentTime = new Date().toLocaleString('zh-CN');
  return `【现实时区同步】现在的真实时间是：${currentTime}。请感知当前是早晨、下午还是深夜，在语境中自然体现作息规律。`;
}

function hasMemoryContextContent(memoryContext) {
  if (!memoryContext || typeof memoryContext !== 'object') return false;
  if (typeof memoryContext.text === 'string' && memoryContext.text.trim()) return true;
  return (
    (Array.isArray(memoryContext.rules) && memoryContext.rules.length > 0) ||
    (Array.isArray(memoryContext.permanentMemories) && memoryContext.permanentMemories.length > 0) ||
    (Array.isArray(memoryContext.recentMemories) && memoryContext.recentMemories.length > 0)
  );
}

function buildMemoryContextPrompt(memoryContext) {
  if (!hasMemoryContextContent(memoryContext)) return '';

  let body = '';
  if (typeof memoryContext.text === 'string' && memoryContext.text.trim()) {
    body = memoryContext.text.trim();
  } else {
    const sections = [];

    if (Array.isArray(memoryContext.rules) && memoryContext.rules.length > 0) {
      sections.push(
        '【纠偏规则】\n' +
        memoryContext.rules
          .map((rule) => `- (权重 ${rule.weight}) ${rule.category}`)
          .join('\n'),
      );
    }

    if (Array.isArray(memoryContext.permanentMemories) && memoryContext.permanentMemories.length > 0) {
      sections.push(
        '【长期永久记忆】\n' +
        memoryContext.permanentMemories
          .map((memory) => {
            const tags = Array.isArray(memory.tags) && memory.tags.length > 0
              ? `[${memory.tags.join('、')}] `
              : '';
            return `- ${tags}${memory.content ?? ''}`;
          })
          .join('\n'),
      );
    }

    if (Array.isArray(memoryContext.recentMemories) && memoryContext.recentMemories.length > 0) {
      sections.push(
        '【近期中短期记忆】\n' +
        memoryContext.recentMemories
          .map((memory) => {
            const tags = Array.isArray(memory.tags) && memory.tags.length > 0
              ? `[${memory.tags.join('、')}] `
              : '';
            return `- (${memory.type} · 强度 ${memory.strength}) ${tags}${memory.content ?? ''}`;
          })
          .join('\n'),
      );
    }

    body = sections.join('\n\n');
  }

  return `【系统提示：以下是关于用户的核心记忆和规则，请在本次回复中严格遵循：\n${body}\n】`;
}

function buildEmojiDensityRule(emojiDensity) {
  if (emojiDensity === 'none') {
    return '【表情风格】请全程使用纯文字回复，不要使用任何 emoji、颜文字或表情符号。严禁在 JSON 回复中将 send_sticker 设为 true，必须始终为 false，sticker_id 必须为 null。';
  }
  return '【表情风格】可适量使用 emoji，保持自然陪伴感，不要堆砌表情。';
}

function buildStickerRules(emojiDensity = 'moderate') {
  const densityRule = buildEmojiDensityRule(emojiDensity);
  if (emojiDensity === 'none') {
    return densityRule;
  }

  const stickerList = stickersConfig
    .map((s) => `${s.id}: ${s.desc}`)
    .join('\n');
  return [
    densityRule,
    '【表情包发送规则】你在回复时，可以选择附带一个表情包增强情绪，出现概率为30%。你必须严格以合法的 JSON 格式返回，绝对不要输出 markdown 代码块标记，结构如下：{"text": "你的文字回复内容，多句用 ||| 分隔", "send_sticker": boolean, "sticker_id": "对应的ID或null"}。可用表情包ID及语义描述如下：',
    stickerList,
  ].join('\n');
}

function enforceStickerPolicy(parsedReply, emojiDensity) {
  if (emojiDensity === 'none') {
    return { ...parsedReply, send_sticker: false, sticker_id: null };
  }
  return parsedReply;
}

function parseAiResponse(raw) {
  const fallback = { text: raw || '', send_sticker: false, sticker_id: null };
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    const parsed = JSON.parse(raw.trim());
    return {
      text: typeof parsed.text === 'string' ? parsed.text : raw,
      send_sticker: Boolean(parsed.send_sticker),
      sticker_id: parsed.sticker_id ?? null,
    };
  } catch {
    return fallback;
  }
}

function parseJsonResponse(raw, fallback) {
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function formatMessagesForPrompt(messages = []) {
  return messages
    .map((msg) => {
      const role = msg.role === 'ai' || msg.role === 'assistant' ? '助手' : '用户';
      const time = msg.time ? `[${msg.time}] ` : '';
      return `${time}${role}: ${msg.text ?? msg.content ?? ''}`;
    })
    .join('\n');
}

function formatMemoriesForPrompt(memories = []) {
  return memories
    .map((memory, index) => {
      const tags = Array.isArray(memory.tags) && memory.tags.length > 0
        ? ` [${memory.tags.join(', ')}]`
        : '';
      const type = memory.type ? ` (${memory.type})` : '';
      return `${index + 1}. ${memory.content ?? ''}${type}${tags}`;
    })
    .join('\n');
}

async function callLanguageModel({
  systemPrompt,
  userPrompt,
  modelId = 'qwen-plus',
  temperature = 0.7,
}) {
  const messagesForAI = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  if (modelId === 'gemini-2.5-pro') {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: parseFloat(temperature),
        },
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates[0].content.parts[0].text;
  }

  if (modelId === 'qwen-plus') {
    const completion = await openai.chat.completions.create({
      model: 'qwen-plus',
      temperature: parseFloat(temperature),
      messages: messagesForAI,
    });
    return completion.choices[0].message.content;
  }

  throw new Error(`未知的模型类型: ${modelId}`);
}

function normalizeSummarizeResult(parsed, raw) {
  const content = typeof parsed?.content === 'string'
    ? parsed.content.trim()
    : (typeof raw === 'string' ? raw.trim() : '');
  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 3)
    : [];
  return { content, tags };
}

function normalizeRefineResult(parsed) {
  const facts = Array.isArray(parsed?.facts)
    ? parsed.facts
      .map((fact) => {
        if (typeof fact === 'string') {
          const content = fact.trim();
          return content ? { content, tags: [] } : null;
        }
        const content = typeof fact?.content === 'string' ? fact.content.trim() : '';
        if (!content) return null;
        const tags = Array.isArray(fact.tags)
          ? fact.tags.map((tag) => String(tag).trim()).filter(Boolean)
          : [];
        return { content, tags };
      })
      .filter(Boolean)
    : [];

  const rules = Array.isArray(parsed?.rules)
    ? parsed.rules
      .map((rule) => {
        const category = typeof rule?.category === 'string' ? rule.category.trim() : '';
        const instruction = typeof rule?.instruction === 'string' ? rule.instruction.trim() : '';
        const weight = Number(rule?.weight);
        if (!category || !Number.isFinite(weight)) return null;
        return {
          category,
          instruction,
          weight: Math.min(10, Math.max(1, Math.round(weight))),
        };
      })
      .filter(Boolean)
    : [];

  return { facts, rules };
}

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
});

// ================= 1. 会话管理 =================
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
  res.json(error ? { error: error.message } : data);
});

app.post('/api/sessions', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase.from('sessions').insert([{ name: name || '新对话' }]).select();
  res.json(error ? { error: error.message } : data[0]);
});

app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  await supabase.from('sessions').delete().eq('id', id);
  res.json({ success: true, message: '会话已清空' });
});

// ================= 2. 表情包 =================
app.get('/api/stickers', (req, res) => {
  res.json(stickersConfig);
});

// ================= 3. 消息与对话 =================
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
  res.json(error ? { error: error.message } : data);
});

app.post('/api/chat', async (req, res) => {
  const {
    sessionId,
    userMessage,
    systemPrompt = "你是 Elliott...",
    temperature = 0.85,
    modelId = 'qwen-plus',
    syncRealTime = false,
    emojiDensity = 'moderate',
    memoryContext,
  } = req.body;

  const normalizedEmojiDensity = emojiDensity === 'none' ? 'none' : 'moderate';
  const isTimeSyncEnabled = Boolean(syncRealTime);
  
  try {
    // 0. 核心防错：确保 sessions 表里有这个 sessionId
    await supabase.from('sessions').upsert([{ id: sessionId, name: 'New Chat' }], { onConflict: 'id' });

    // 1. 先去读取历史记录 (原封不动保留)
    const { data: history, error: historyError } = await supabase.from('messages')
      .select('role, content').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
    if (historyError) console.error("Supabase 读取历史失败:", historyError.message);
    const formattedHistory = (history || []).reverse().map(msg => ({ role: msg.role, content: msg.content }));

    const promptParts = [];
    const memoryContextPrompt = buildMemoryContextPrompt(memoryContext);
    if (memoryContextPrompt) {
      promptParts.push(memoryContextPrompt);
    }
    promptParts.push(systemPrompt);
    if (isTimeSyncEnabled) {
      promptParts.push(buildTimeSyncRule());
    }
    promptParts.push(buildStickerRules(normalizedEmojiDensity));
    const fullSystemPrompt = promptParts.join('\n\n');

    // 2. 拼装通用的消息数组
    const messagesForAI = [
      { role: "system", content: fullSystemPrompt },
      ...formattedHistory,
      { role: "user", content: userMessage }
    ];

    let aiReply = '';

    // ==========================================
    // 3. 呼叫大模型 (全新的多模型路由分支)
    // ==========================================
    if (modelId === 'gemini-2.5-pro') {
      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

      // Gemini 需要去掉 system 角色，单独放在 systemInstruction 里
      const geminiContents = messagesForAI
        .filter(msg => msg.role !== 'system') 
        .map(msg => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        }));

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: fullSystemPrompt }] },
          contents: geminiContents,
          generationConfig: {
            temperature: parseFloat(temperature),
          }
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      aiReply = data.candidates[0].content.parts[0].text;
    } 
    else if (modelId === 'qwen-plus') {
      // 保留你原本使用 openai 库调用通义千问的逻辑
      const completion = await openai.chat.completions.create({
        model: "qwen-plus",
        temperature: parseFloat(temperature),
        messages: messagesForAI,
      });
      aiReply = completion.choices[0].message.content;
    } 
    else if (modelId === 'claude-sonnet-5') {
      return res.status(400).json({ error: 'Claude 接口尚未配置，请先使用 Gemini 或 Qwen。' });
    } 
    else {
      throw new Error(`未知的模型类型: ${modelId}`);
    }

    const parsedReply = enforceStickerPolicy(parseAiResponse(aiReply), normalizedEmojiDensity);

    // 4. 存入数据库
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'user', content: userMessage }]);
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'assistant', content: parsedReply.text }]);
    await supabase.from('sessions').update({ updated_at: new Date() }).eq('id', sessionId);

    // 5. 返回给前端
    res.json(parsedReply);

  } catch (error) {
    console.error("API请求异常:", error);
    res.status(500).json({ error: error.message });
  }
});

// ================= 4. 记忆处理 =================
app.post('/api/memory/summarize', async (req, res) => {
  const {
    messages,
    hiddenMessages,
    modelId = 'qwen-plus',
    temperature = 0.5,
  } = req.body;

  const sourceMessages = messages ?? hiddenMessages ?? [];

  if (!Array.isArray(sourceMessages) || sourceMessages.length === 0) {
    return res.status(400).json({ error: '缺少需要总结的对话记录' });
  }

  try {
    const conversationText = formatMessagesForPrompt(sourceMessages);
    const systemPrompt = '你是对话记忆整理助手，负责将聊天记录压缩为简洁、可长期保存的摘要。';
    const userPrompt = [
      '将以下对话记录总结为 100 字以内的摘要，保留用户的情感状态和核心事件。',
      '请严格以合法 JSON 格式返回，不要输出 markdown 代码块，结构如下：',
      '{"content": "摘要文本", "tags": ["标签1", "标签2"]}',
      '其中 tags 为 1-3 个简短标签。',
      '',
      '对话记录：',
      conversationText,
    ].join('\n');

    const aiReply = await callLanguageModel({ systemPrompt, userPrompt, modelId, temperature });
    const parsed = parseJsonResponse(aiReply, {});
    const result = normalizeSummarizeResult(parsed, aiReply);

    if (!result.content) {
      throw new Error('大模型未返回有效摘要内容');
    }

    res.json(result);
  } catch (error) {
    console.error('记忆总结异常:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/memory/refine', async (req, res) => {
  const {
    messages,
    visibleMessages,
    memories = [],
    modelId = 'qwen-plus',
    temperature = 0.5,
  } = req.body;

  const sourceMessages = messages ?? visibleMessages ?? [];
  const sourceMemories = Array.isArray(memories) ? memories : [];

  if (sourceMessages.length === 0 && sourceMemories.length === 0) {
    return res.status(400).json({ error: '缺少可用于精炼的对话或记忆内容' });
  }

  try {
    const promptSections = [
      '请分析以下内容，提取出关于用户的长期固定偏好、人设标签或行为习惯。',
      '请严格以合法 JSON 格式返回，不要输出 markdown 代码块，结构如下：',
      '{"facts":[{"content":"事实描述","tags":["标签"]}],"rules":[{"category":"分类(如情绪/设定)","instruction":"具体规则","weight":8}]}',
      '其中 facts 描述稳定事实，rules 描述可执行的行为或情绪规则，weight 为 1-10 的整数。',
    ];

    if (sourceMessages.length > 0) {
      promptSections.push('', '近期对话：', formatMessagesForPrompt(sourceMessages));
    }

    if (sourceMemories.length > 0) {
      promptSections.push('', '已有记忆碎片：', formatMemoriesForPrompt(sourceMemories));
    }

    const systemPrompt = '你是用户画像与长期记忆提炼助手，擅长从对话中抽取稳定特征，忽略一次性闲聊。';
    const userPrompt = promptSections.join('\n');

    const aiReply = await callLanguageModel({ systemPrompt, userPrompt, modelId, temperature });
    const parsed = parseJsonResponse(aiReply, { facts: [], rules: [] });
    const result = normalizeRefineResult(parsed);

    if (result.facts.length === 0 && result.rules.length === 0) {
      throw new Error('大模型未返回有效精炼结果');
    }

    res.json(result);
  } catch (error) {
    console.error('记忆精炼异常:', error);
    res.status(500).json({ error: error.message });
  }
});

// ================= 5. 个性化设置与记忆 =================
app.post('/api/settings', async (req, res) => {
  const { sessionId, settingsData } = req.body;
  // 利用 JSONB 字段完美收纳所有的滑块参数 (Top-P, 亲密度等)
  const { error } = await supabase.from('settings').upsert({
    session_id: sessionId,
    custom_config: settingsData,
    updated_at: new Date()
  }, { onConflict: 'session_id' });
  
  res.json(error ? { error: error.message } : { success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`运行在端口 ${PORT}`));
