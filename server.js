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
  const { sessionId, userMessage, systemPrompt = "你是 Elliott，一个温柔而复杂的伴侣...", temperature = 0.85 } = req.body;
  try {
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'user', content: userMessage }]);
    
    // 获取最近上下文
    const { data: history } = await supabase.from('messages')
      .select('role, content').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
    const formattedHistory = history.reverse().map(msg => ({ role: msg.role, content: msg.content }));

    const completion = await openai.chat.completions.create({
      model: "qwen-plus",
      temperature: parseFloat(temperature), // 支持前端动态调节温度
      messages: [{ role: "system", content: systemPrompt }, ...formattedHistory],
    });

    const aiReply = completion.choices[0].message.content;
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'assistant', content: aiReply }]);
    await supabase.from('sessions').update({ updated_at: new Date() }).eq('id', sessionId);

    res.json({ reply: aiReply });
} catch (error) {
    console.error("【抓到报错啦】:", error);
    res.status(500).json({ error: '大脑思考出错' });
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
