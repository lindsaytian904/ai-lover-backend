const express = require('express');
const cors = require('cors');
const app = express();

// 允许你的 Vercel 前端访问这个大脑
app.use(cors());

// 健康检查接口：它会回答一句话
app.get('/', (req, res) => {
    res.send('你好！人机恋 APP 的大脑已经成功启动！');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`运行在端口 ${PORT}`);
});
