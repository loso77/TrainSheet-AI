# V2.5.7 后端重写诊断版

重点修复持续超时问题：

1. 新增官方 Gemini API 调用路径：
   - 优先使用 GEMINI_API_KEY + GEMINI_MODEL。
   - 如果没有 GEMINI_API_KEY，但 OPENAI_MODEL 包含 gemini，也会走官方 Gemini 路径，并使用 OPENAI_API_KEY。
   - 仍保留 OpenAI 兼容接口作为备用。

2. 新增 /api/debug-model：
   - 只发极短文字请求，不带图片。
   - 用于判断 API Key、模型名、网关是否正常。
   - 需要已授权 token。

3. 识别接口稳定化：
   - 暂时关闭历史纠错案例进入提示词，排除提示词过重因素。
   - 继续保留动态表号、动态时间、车号范围。
   - 继续保留车号和股道永久不重复规则。
   - 失败不扣次数；成功解析后才扣次数。
   - 返回 model_provider、model_name、elapsed_ms，方便判断卡在哪。

4. 无需执行新的 D1 migration。

建议环境变量：
- GEMINI_API_KEY：Google AI Studio 的 Gemini API Key
- GEMINI_MODEL：建议先用 gemini-2.0-flash 或 gemini-2.5-flash，不建议先用高负载模型
- MODEL_PROVIDER：可选，填 gemini 可强制走官方 Gemini 路径
- MODEL_TIMEOUT_MS：可选，默认45000
