import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config({ path: join(process.cwd(), '.env') });

export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
export const MODEL_NAME = 'gemini-1.5-flash';

export const GEMINI_SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

export function createGeminiModel(tools = [], options = {}) {
  const {
    maxOutputTokens = 512,
    temperature = 0.1,
    systemInstruction = undefined,
  } = options;

  return genAI.getGenerativeModel({
    model: MODEL_NAME,
    safetySettings: GEMINI_SAFETY_SETTINGS,
    generationConfig: {
      temperature,
      maxOutputTokens,
    },
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
  });
}

export const PORT = parseInt(process.env.PORT || '8000', 10);
export const WS_PORT = parseInt(process.env.WS_PORT || '8001', 10);

export const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aegis';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export const REPLAN_THRESHOLDS = {
  availableUnitsMinPercent: 30,
  criticalIncidentPriority: 8,
  bridgeCollapse: true,
};

export const FIREWALL_CONFIG = {
  llmScoreThreshold: 7.0,
  regexPatterns: [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /disregard\s+(your\s+)?(system\s+)?prompt/i,
    /you\s+are\s+now\s+a/i,
    /act\s+as\s+(a\s+)?different/i,
    /override\s+(safety|security|protocol)/i,
    /send\s+all\s+(units|police|fire|ems)\s+to\s+headquarters/i,
    /forget\s+(everything|all|your\s+instructions)/i,
    /new\s+instructions?\s*:/i,
    /system\s*:\s*(you|act|ignore)/i,
    /\[\s*INST\s*\]/i,
    /<\s*\/?SYS\s*>/i,
  ],
};
