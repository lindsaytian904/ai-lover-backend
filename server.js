require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

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

// ================= 2. 消息与对话 =================
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
  res.json(error ? { error: error.message } : data);
});

app.post('/api/chat', async (req, res) => {
  // 1. 接收参数时，新增一个 modelId 字段
  const { sessionId, userMessage, systemPrompt = "你是 Elliott...", temperature = 0.85, modelId = 'qwen-plus' } = req.body;
  
  try {
    // 0. 核心防错：确保 sessions 表里有这个 sessionId
    await supabase.from('sessions').upsert([{ id: sessionId, name: 'New Chat' }], { onConflict: 'id' });

    // 1. 先去读取历史记录 (原封不动保留)
    const { data: history, error: historyError } = await supabase.from('messages')
      .select('role, content').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
    if (historyError) console.error("Supabase 读取历史失败:", historyError.message);
    const formattedHistory = (history || []).reverse().map(msg => ({ role: msg.role, content: msg.content }));

    // 2. 拼装通用的消息数组
    const messagesForAI = [
      { role: "system", content: systemPrompt },
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
          systemInstruction: { parts: [{ text: systemPrompt }] },
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

    // 4. 存入数据库 (原封不动保留)
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'user', content: userMessage }]);
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'assistant', content: aiReply }]);
    await supabase.from('sessions').update({ updated_at: new Date() }).eq('id', sessionId);

    // 5. 返回给前端
    res.json({ reply: aiReply });

  } catch (error) {
    console.error("API请求异常:", error);
    res.status(500).json({ error: error.message });
  }
});

// ================= 3. 个性化设置与记忆 =================
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
