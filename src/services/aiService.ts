import { GoogleGenAI } from "@google/genai";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash-lite";
const GEMINI_MODELS = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL];

type GeminiKeyConfig =
  | string
  | {
      geminiApiKey?: string;
      aiApiKey?: string;
      apiKey?: string;
    };

const getEnvGeminiApiKey = () =>
  (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.API_KEY || "").trim();

const getGeminiApiKey = (keys: GeminiKeyConfig = "") => {
  if (typeof keys === "string") {
    return keys.trim() || getEnvGeminiApiKey();
  }

  return (
    keys.geminiApiKey?.trim() ||
    keys.aiApiKey?.trim() ||
    keys.apiKey?.trim() ||
    getEnvGeminiApiKey()
  );
};

const normalizePart = (part: any) =>
  typeof part === "string" ? { text: part } : part;

const normalizeContents = (contents: any) => {
  if (!Array.isArray(contents)) return contents;

  const isContentList = contents.every(
    (item) => item && typeof item === "object" && ("role" in item || "parts" in item)
  );

  if (isContentList) {
    return contents.map((item) => ({
      role: item.role || "user",
      parts: Array.isArray(item.parts)
        ? item.parts.map(normalizePart)
        : [normalizePart(item)],
    }));
  }

  return [{ role: "user", parts: contents.map(normalizePart) }];
};

const buildGeminiConfig = (config: any = {}) => ({
  systemInstruction: config.systemInstruction,
  temperature: config.temperature ?? 0.7,
  maxOutputTokens: config.maxOutputTokens,
  responseMimeType: config.responseMimeType,
  responseSchema: config.responseSchema,
});

const isRetryableGeminiError = (error: any) => {
  const status = Number(error?.status || error?.response?.status || error?.error?.status);
  const message = String(error?.message || "").toLowerCase();

  return (
    status === 429 ||
    status >= 500 ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable")
  );
};

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 1500): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (!isRetryableGeminiError(error) || retries <= 0) {
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

async function callAI(params: any, keys: GeminiKeyConfig = "") {
  const apiKey = getGeminiApiKey(keys);
  if (!apiKey) {
    throw new Error("Vui long cau hinh Gemini API Key trong phan Cai dat hoac bien moi truong GEMINI_API_KEY.");
  }

  const ai = new GoogleGenAI({ apiKey });
  let lastError: any;

  for (const model of GEMINI_MODELS) {
    try {
      const response = await withRetry(() =>
        ai.models.generateContent({
          model,
          contents: normalizeContents(params.contents),
          config: buildGeminiConfig(params.config),
        })
      );

      const rawText = (response as any).text;
      const text = typeof rawText === "function" ? rawText.call(response) : rawText || "";
      return { text: () => text };
    } catch (error: any) {
      lastError = error;
      console.error(`Gemini Error (${model}):`, error);

      if (String(error?.message || "").includes("API key not valid")) {
        throw new Error("Gemini API Key khong hop le. Vui long kiem tra lai trong phan Cai dat.");
      }

      if (!isRetryableGeminiError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Khong the ket noi Gemini. Vui long thu lai sau.");
}

const parseJson = (text: string) => {
  try {
    let cleanText = text.trim();
    const fenced = cleanText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) cleanText = fenced[1].trim();

    if (!cleanText.startsWith("{") && !cleanText.startsWith("[")) {
      const objectIndex = cleanText.indexOf("{");
      const arrayIndex = cleanText.indexOf("[");
      if (arrayIndex >= 0 && (objectIndex < 0 || arrayIndex < objectIndex)) {
        cleanText = cleanText.slice(arrayIndex, cleanText.lastIndexOf("]") + 1);
      } else if (objectIndex >= 0) {
        cleanText = cleanText.slice(objectIndex, cleanText.lastIndexOf("}") + 1);
      }
    }

    cleanText = cleanText
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/^\uFEFF/, "");

    return JSON.parse(cleanText);
  } catch (error) {
    console.error("JSON Parse Error:", error, "Original text:", text);
    return {};
  }
};

const asArray = (value: any) => (Array.isArray(value) ? value : []);

const normalizeFlashcards = (result: any) => {
  const rawCards = asArray(result?.flashcards || result?.cards || (Array.isArray(result) ? result : []));
  return rawCards
    .map((card) => ({
      front: String(card?.front || card?.question || "").trim(),
      back: String(card?.back || card?.answer || card?.explanation || "").trim(),
      type: card?.type === "cloze" ? "cloze" : "basic",
      imageUrl: card?.imageUrl || "",
      tags: Array.isArray(card?.tags) ? card.tags.filter(Boolean).map(String) : [],
    }))
    .filter((card) => card.front && card.back);
};

const normalizeQuestions = (result: any) => {
  const rawQuestions = asArray(result?.questions || result?.question || (Array.isArray(result) ? result : []));
  return rawQuestions
    .map((question) => {
      const options = asArray(question?.options).map((option) => String(option).trim()).filter(Boolean);
      const rawCorrectAnswer = question?.correctAnswer ?? question?.answerIndex ?? question?.correct;
      const correctAnswer = typeof rawCorrectAnswer === "string"
        ? rawCorrectAnswer.length === 1 && /[A-D]/i.test(rawCorrectAnswer)
          ? rawCorrectAnswer.toUpperCase().charCodeAt(0) - 65
          : Number(rawCorrectAnswer)
        : Number(rawCorrectAnswer);

      return {
        question: String(question?.question || "").trim(),
        options,
        correctAnswer: Number.isFinite(correctAnswer) ? correctAnswer : -1,
        explanation: String(question?.explanation || question?.rationale || "").trim(),
      };
    })
    .filter((question) =>
      question.question &&
      question.options.length >= 2 &&
      question.correctAnswer >= 0 &&
      question.correctAnswer < question.options.length
    );
};

const MED_SOURCES = `
SOURCES: Internal medicine (AHA/ACC, ESC, ADA, GINA, Harrison), Surgery (Schwartz, Sabiston), Trauma/Ortho (AO Reference/AO Surgery Reference, Orthobullets, PubMed, UpToDate, Skeletal Trauma), ECG (ECGs Made Easy, Life in the Fast Lane ECG Library, The Only EKG Book You'll Ever Need, Marriott's Practical Electrocardiography), OB-GYN (Williams, ACOG), Pediatrics (Nelson, hospital protocols).
REQUIREMENTS: cite the most relevant source family when useful, explain clinical reasoning, and include comorbidity considerations.
`;

const TRAUMA_ORTHO_SOURCE_NOTE =
  "For trauma and orthopaedics, prioritize AO Reference/AO Surgery Reference, Orthobullets, Skeletal Trauma, PubMed reviews/guidelines, and UpToDate when creating general exam questions.";

const ECG_SOURCE_NOTE =
  "For ECG questions, prioritize ECGs Made Easy, Life in the Fast Lane ECG Library, The Only EKG Book You'll Ever Need, and Marriott's Practical Electrocardiography. Basic mode should cover rate, rhythm, axis, intervals, hypertrophy, conduction blocks, ischemia basics, and common electrolyte/drug patterns. Advanced mode should use clinical ECG interpretation cases, arrhythmia mechanisms, AV blocks, bundle branch blocks, wide-complex tachycardia, STEMI localization and mimics, pericarditis, PE, WPW, electrolyte/drug toxicity, and management-oriented reasoning.";

export async function generateFlashcardsFromText(
  text: string,
  count = 5,
  emphasis = "",
  apiKey: GeminiKeyConfig = "",
  imageBase64?: string
) {
  const parts: any[] = [{ text: text || "Analyze the provided learning material." }];
  if (imageBase64) {
    const match = imageBase64.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }

  const response = await callAI(
    {
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: `You are a professional medical learning assistant. Create ${count} high-yield flashcards from the provided content. ${emphasis ? `Focus area: ${emphasis}` : ""}
Return Vietnamese content with English medical terms in parentheses when useful.
Return only valid JSON in this shape: { "flashcards": [{ "front": "...", "back": "..." }] }.`,
        responseMimeType: "application/json",
      },
    },
    apiKey
  );

  return normalizeFlashcards(parseJson(response.text()));
}

export async function generateClinicalFlashcardsFromVoice(
  transcript: string,
  apiKey: GeminiKeyConfig = ""
) {
  const systemInstruction = `You are a clinical reasoning assistant.
Task: analyze a clinical voice transcript, remove repetition/noise, and extract compact flashcards.
Focus on key symptoms, differential diagnosis, needed investigations, management, and clinical reasoning.
Use Vietnamese with bilingual medical terminology when useful.
Return only valid JSON: { "flashcards": [{ "front": "...", "back": "..." }] }.`;

  const response = await callAI(
    {
      contents: `Clinical transcript: "${transcript}"
Create medical flashcards from the important content above.`,
      config: { systemInstruction, responseMimeType: "application/json" },
    },
    apiKey
  );

  return normalizeFlashcards(parseJson(response.text()));
}

export async function generateClinicalFlashcardsFromMedia(
  fileData: string,
  mimeType: string,
  apiKey: GeminiKeyConfig = ""
) {
  const systemInstruction = `You are a doctor analyzing clinical media.
Task: understand the uploaded audio/video/visual material and extract the most important medical learning points as flashcards.
Return Vietnamese content, with English medical terminology when useful.
Return only valid JSON: { "flashcards": [{ "front": "...", "back": "..." }] }.`;

  const response = await callAI(
    {
      contents: [
        {
          inlineData: {
            data: fileData,
            mimeType,
          },
        },
        "Analyze this media file and create flashcards from the most important medical content.",
      ],
      config: { systemInstruction, responseMimeType: "application/json" },
    },
    apiKey
  );

  return normalizeFlashcards(parseJson(response.text()));
}

export async function generateExam(
  cards: any[],
  count = 10,
  apiKey: GeminiKeyConfig = "",
  context = "",
  _deckInfo?: any,
  difficulty = "advanced"
) {
  const isAdvanced = difficulty === "advanced";
  const systemInstruction = `You are a senior medical professor writing MCQ exam questions. ${MED_SOURCES}
Create questions based on the user's flashcards and notes.
${isAdvanced
  ? "Advanced mode: use clinical vignettes, applied reasoning, diagnosis, next best step, and treatment choices."
  : "Basic mode: focus on definitions, classifications, symptoms, diagnostic criteria, and core theory."}
Return Vietnamese questions with English medical terms in parentheses when helpful.
Each option must be the full answer text, not just A/B/C/D labels.
Return only valid JSON: { "questions": [{ "question": "...", "options": ["option text", "option text", "option text", "option text"], "correctAnswer": 0, "explanation": "..." }] }.`;

  const response = await callAI(
    {
      contents: `DATA FOR EXAM:
- FLASHCARDS: ${JSON.stringify(cards.map((card) => ({ f: card.front, b: card.back })))}
- MINDMAP/NOTES: ${context}
Create ${count} ${isAdvanced ? "advanced clinical" : "basic theory"} MCQ questions from the data above.`,
      config: { systemInstruction, responseMimeType: "application/json" },
    },
    apiKey
  );

  const result = parseJson(response.text());
  return normalizeQuestions(result);
}

export async function generateGeneralExam(
  specialty: string,
  count = 10,
  apiKey: GeminiKeyConfig = "",
  difficulty = "advanced"
) {
  const isAdvanced = difficulty === "advanced";
  const specMap: Record<string, string> = {
    internal: "Noi khoa",
    surgery: "Ngoai khoa",
    trauma_ortho: "Chan thuong chinh hinh",
    ecg: "Dien tam do ECG",
    pediatrics: "Nhi khoa",
    obgyn: "San phu khoa",
    all: "Tong hop cac chuyen khoa y khoa",
  };

  const specialtyName = specMap[specialty] || "Y khoa tong hop";
  const systemInstruction = `You are a leading medical lecturer creating MCQs for ${specialtyName}. ${MED_SOURCES}
${specialty === "trauma_ortho" || specialty === "all" ? TRAUMA_ORTHO_SOURCE_NOTE : ""}
${specialty === "ecg" ? ECG_SOURCE_NOTE : ""}
${isAdvanced
  ? "Advanced mode: most questions should be case-based and require clinical reasoning."
  : "Basic mode: focus on standard textbook knowledge, symptoms, classifications, definitions, and diagnostic criteria."}
Return Vietnamese questions with English medical terms in parentheses when helpful.
Return only valid JSON: { "questions": [{ "question": "...", "options": ["...", "...", "...", "..."], "correctAnswer": 0, "explanation": "..." }] }.`;

  const response = await callAI(
    {
      contents: `Create ${count} ${specialtyName} MCQ questions at ${isAdvanced ? "advanced clinical" : "basic review"} level.
Use Vietnamese. Return JSON only.`,
      config: { systemInstruction, responseMimeType: "application/json" },
    },
    apiKey
  );

  const result = parseJson(response.text());
  return normalizeQuestions(result);
}

export async function generateMindmap(text: string, apiKey: GeminiKeyConfig = "") {
  const response = await callAI(
    {
      contents: `Content: ${text}
Create a concise hierarchical medical study summary using Markdown headings and bullet points.
Focus on clinical links, pathophysiology, and key clinical pearls.`,
      config: {
        systemInstruction: "You are a medical education expert. Answer in Vietnamese with a clear structure.",
      },
    },
    apiKey
  );

  return response.text();
}

export async function suggestStudyPath(userStats: any, apiKey: GeminiKeyConfig = "") {
  const response = await callAI(
    {
      contents: `Stats: ${JSON.stringify(userStats)}. Suggest a concise medical study path.`,
      config: {
        systemInstruction: "You are a medical education coach. Answer in Vietnamese.",
      },
    },
    apiKey
  );

  return response.text();
}
