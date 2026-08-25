require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

// 1. 初始化 Supabase 数据库连接
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. 初始化阿里云大模型连接 (使用兼容模式)
const openai = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', 
});

// 测试接口
app.get('/', (req, res) => {
  res.send('你好！人机恋 APP 的大脑已连接数据库和阿里云！');
});

// 核心对话接口
app.post('/chat', async (req, res) => {
  const { sessionId, userMessage } = req.body;

  try {
    // a. 把用户的话存入数据库
    await supabase.from('messages').insert([
      { session_id: sessionId, role: 'user', content: userMessage }
    ]);

    // b. 组装发给阿里云的上下文 (这里简化为只发当前消息，后续可扩充历史记忆)
    const completion = await openai.chat.completions.create({
      model: "qwen-plus", // 你可以根据需要换成 qwen-max 等
      messages: [
        { role: "system", content: "你是一个温柔而复杂的伴侣..." },
        { role: "user", content: userMessage }
      ],
    });

    const aiReply = completion.choices[0].message.content;

    // c. 把 AI 的回复存入数据库
    await supabase.from('messages').insert([
      { session_id: sessionId, role: 'assistant', content: aiReply }
    ]);

    // d. 把回复传回给前端
    res.json({ reply: aiReply });

  } catch (error) {
    console.error('大脑思考出错:', error);
    res.status(500).json({ error: '大脑遇到点小问题' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`运行在端口 ${PORT}`);
});
