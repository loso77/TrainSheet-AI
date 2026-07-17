# TrainSheet AI V2.6.0：原 AI / 豆包 AI 手动选择

本版保留原 Gemini 识别，同时增加火山方舟豆包视觉模型。前端每次请求通过 `provider` 选择一个模型，不会同时调用两个模型。

## Cloudflare Pages 环境变量

在 Production 环境中增加：

- 加密机密 `DOUBAO_API_KEY`：火山方舟 API Key
- 普通变量 `DOUBAO_MODEL`：`doubao-seed-2-1-pro-260628`
- 可选普通变量 `DOUBAO_API_URL`：默认已使用 `https://ark.cn-beijing.volces.com/api/v3/chat/completions`

原有 Gemini、D1、设备授权、请求额度和纠错学习配置均无需修改。

## 接口变化

- `POST /api/recognize`：请求体可传 `provider: "gemini"` 或 `provider: "doubao"`
- `POST /api/debug-model`：请求体可传相同的 `provider`，仅测试所选模型
- `GET /api/health`：返回两个模型是否已配置，以及豆包模型 ID

模型调用失败时不会扣除识别次数。
