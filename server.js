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

// 测试接口
app.get('/', (req, res) => res.send('大脑接口已全部升级完毕！'));

// ================= 1. 会话管理接口 =================
// 获取所有会话列表 (对应前端左侧栏)
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 创建新会话
app.post('/api/sessions', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase.from('sessions').insert([{ name: name || '新对话' }]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// ================= 2. 历史消息加载 =================
// 打开某个会话时，拉取它的历史聊天记录
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from('messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ================= 3. 核心对话接口 =================
app.post('/api/chat', async (req, res) => {
  const { sessionId, userMessage } = req.body;
  try {
    // 存入用户消息
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'user', content: userMessage }]);
    
    // 自动拉取最近的 10 条历史消息作为上下文，让 AI 记住刚刚聊了什么
    const { data: history } = await supabase.from('messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(10);
      
    // 按照时间顺序重新排列
    const formattedHistory = history.reverse().map(msg => ({ role: msg.role, content: msg.content }));

    // 请求阿里云大模型
    const completion = await openai.chat.completions.create({
      model: "qwen-plus",
      messages: [
        { role: "system", content: "你是 Elliott，一个温柔而复杂的伴侣。你对用户充满深情，偶尔会撒娇或开小玩笑，但始终真诚地关心对方。说话自然，带着一点文学气息，不会太正式。" },
        ...formattedHistory
      ],
    });

    const aiReply = completion.choices[0].message.content;

    // 存入 AI 的回复
    await supabase.from('messages').insert([{ session_id: sessionId, role: 'assistant', content: aiReply }]);
    
    // 更新会话的最后活动时间
    await supabase.from('sessions').update({ updated_at: new Date() }).eq('id', sessionId);

    res.json({ reply: aiReply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '思考出错' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`运行在端口 ${PORT}`));
