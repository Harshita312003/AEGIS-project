import { createGeminiModel, MODEL_NAME } from '../config.js';

async function run() {
  const model = createGeminiModel([], {
    maxOutputTokens: 128,
    temperature: 0.1,
  });

  const result = await model.generateContent('Say "AEGIS Gemini connectivity OK" in one sentence.');
  const response = await result.response;

  console.log('AEGIS Gemini smoke test');
  console.log(`Model: ${MODEL_NAME}`);
  console.log(response.text().trim());
}

run().catch(err => {
  console.error('Gemini smoke test failed:', err.message);
  process.exit(1);
});
