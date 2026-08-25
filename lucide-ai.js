// Lucide AI backend — Gemini → Groq → Mistral automatic fallback
// Environment variables required on Vercel:
//   GEMINI_API_KEY
//   GROQ_API_KEY
//   MISTRAL_API_KEY

const PROVIDER_TIMEOUT_MS = 35000;

function json(res, status, body) {
  return res.status(status).json(body);
}

function cleanJsonText(value) {
  if (typeof value !== "string") return value;
  const cleaned = value
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

function taskFromPrompt(prompt) {
  if (/"niches"\s*:/.test(prompt)) return "niche";
  if (/"idees"\s*:/.test(prompt)) return "ideas";
  if (/"gagnant"\s*:/.test(prompt)) return "compare";
  if (/"score"\s*:/.test(prompt)) return "analyze";
  return "generic";
}

function schemaFor(task) {
  if (task === "niche") {
    return {
      type: "OBJECT",
      properties: {
        niches: {
          type: "ARRAY",
          items: { type: "STRING" }
        }
      },
      required: ["niches"]
    };
  }

  if (task === "ideas") {
    return {
      type: "OBJECT",
      properties: {
        idees: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              titre: { type: "STRING" },
              format: { type: "STRING" },
              raison: { type: "STRING" },
              structure: {
                type: "ARRAY",
                items: { type: "STRING" }
              },
              script_complet: { type: "STRING" }
            },
            required: ["titre", "format", "raison", "structure", "script_complet"]
          }
        }
      },
      required: ["idees"]
    };
  }

  if (task === "analyze") {
    return {
      type: "OBJECT",
      properties: {
        score: { type: "INTEGER" },
        verdict: { type: "STRING" },
        subscores: {
          type: "OBJECT",
          properties: {
            accroche: { type: "INTEGER" },
            rythme: { type: "INTEGER" },
            appel_action: { type: "INTEGER" },
            clarte: { type: "INTEGER" }
          },
          required: ["accroche", "rythme", "appel_action", "clarte"]
        },
        points_forts: { type: "ARRAY", items: { type: "STRING" } },
        points_faibles: { type: "ARRAY", items: { type: "STRING" } },
        hooks_alternatifs: { type: "ARRAY", items: { type: "STRING" } },
        legende: { type: "STRING" },
        hashtags: { type: "STRING" }
      },
      required: [
        "score", "verdict", "subscores", "points_forts",
        "points_faibles", "hooks_alternatifs", "legende", "hashtags"
      ]
    };
  }

  if (task === "compare") {
    return {
      type: "OBJECT",
      properties: {
        gagnant: { type: "STRING", enum: ["A", "B"] },
        raison: { type: "STRING" },
        score_a: { type: "INTEGER" },
        score_b: { type: "INTEGER" },
        conseil_fusion: { type: "STRING" }
      },
      required: ["gagnant", "raison", "score_a", "score_b", "conseil_fusion"]
    };
  }

  return {
    type: "OBJECT",
    properties: {
      response: { type: "STRING" }
    },
    required: ["response"]
  };
}

function normalizeResult(task, value) {
  const data = cleanJsonText(value);
  if (!data || typeof data !== "object") {
    throw new Error("Réponse JSON vide ou illisible.");
  }

  if (task === "niche") {
    if (!Array.isArray(data.niches)) throw new Error("Réponse niche invalide.");
    data.niches = data.niches.filter(Boolean).slice(0, 4).map(String);
    if (!data.niches.length) throw new Error("Aucune niche générée.");
  }

  if (task === "ideas") {
    if (!Array.isArray(data.idees)) throw new Error("Réponse idées invalide.");
    data.idees = data.idees
      .filter(x => x && typeof x === "object")
      .slice(0, 4)
      .map(x => ({
        titre: String(x.titre || "Idée"),
        format: String(x.format || "Vidéo courte"),
        raison: String(x.raison || ""),
        structure: Array.isArray(x.structure) ? x.structure.map(String).slice(0, 6) : [],
        script_complet: String(x.script_complet || "")
      }));
    if (!data.idees.length) throw new Error("Aucune idée générée.");
  }

  return data;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readProviderError(response) {
  try {
    const data = await response.json();
    return data?.error?.message || data?.error || data?.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function imagePartsForGemini(images) {
  return (images || []).map(b64 => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: b64
    }
  }));
}

function imagePartsForOpenAICompatible(images) {
  return (images || []).map(b64 => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${b64}` }
  }));
}

async function callGemini(prompt, maxTokens, images, task) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY non configurée.");

  const contents = [{
    role: "user",
    parts: [
      { text: prompt },
      ...imagePartsForGemini(images)
    ]
  }];

  const body = {
    contents,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schemaFor(task),
      temperature: 0.7,
      maxOutputTokens: Math.min(Math.max(Number(maxTokens) || 1800, 500), 5000)
    }
  };

  const response = await fetchWithTimeout(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(await readProviderError(response));
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p?.text || "").join("").trim();
  if (!text) throw new Error("Gemini a répondu sans contenu.");

  return normalizeResult(task, text);
}

async function callGroq(prompt, maxTokens, images, task) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY non configurée.");

  // GPT-OSS 120B is text-only. Do not send image requests to it.
  if (images?.length) {
    throw new Error("Groq GPT-OSS 120B ne prend pas les images en entrée.");
  }

  const effectiveMax = Math.min(
    task === "ideas" ? 2200 : 1800,
    Math.max(Number(maxTokens) || 1600, 500)
  );

  const messages = [
    {
      role: "system",
      content:
        "Tu es le moteur IA de Lucide. Réponds UNIQUEMENT en JSON valide. " +
        "Respecte exactement la structure JSON demandée par l'utilisateur. " +
        "N'ajoute aucun markdown ni commentaire."
    },
    { role: "user", content: prompt }
  ];

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages,
        temperature: 0.7,
        max_tokens: effectiveMax,
        response_format: { type: "json_object" },
        reasoning_effort: "medium"
      })
    }
  );

  if (!response.ok) {
    throw new Error(await readProviderError(response));
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq a répondu sans contenu.");

  return normalizeResult(task, text);
}

async function callMistral(prompt, maxTokens, images, task) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY non configurée.");

  const content = images?.length
    ? [
        { type: "text", text: prompt },
        ...imagePartsForOpenAICompatible(images)
      ]
    : prompt;

  // Pixtral is used for image requests; Small is used for normal text requests.
  const model = images?.length ? "pixtral-12b-2409" : "mistral-small-latest";

  const response = await fetchWithTimeout(
    "https://api.mistral.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "Tu es le moteur de secours de Lucide. Réponds UNIQUEMENT avec un objet JSON valide. " +
              "Respecte exactement le format demandé."
          },
          { role: "user", content }
        ],
        temperature: 0.7,
        max_tokens: Math.min(Math.max(Number(maxTokens) || 1800, 500), 4000),
        response_format: { type: "json_object" }
      })
    }
  );

  if (!response.ok) {
    throw new Error(await readProviderError(response));
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Mistral a répondu sans contenu.");

  return normalizeResult(task, text);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  try {
    const body = req.body || {};
    const prompt = String(body.prompt || "").trim();
    const maxTokens = Number(body.maxTokens || body.max_tokens || 1800);
    const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];

    if (!prompt) {
      return json(res, 400, { error: "Prompt manquant." });
    }

    const task = taskFromPrompt(prompt);
    const attempts = [];
    const providers = [
      ["gemini", () => callGemini(prompt, maxTokens, images, task)],
      ["groq", () => callGroq(prompt, maxTokens, images, task)],
      ["mistral", () => callMistral(prompt, maxTokens, images, task)]
    ];

    for (const [name, fn] of providers) {
      try {
        const result = await fn();
        return json(res, 200, result);
      } catch (error) {
        attempts.push(`${name}: ${error?.message || "erreur inconnue"}`);
      }
    }

    return json(res, 503, {
      error: "Les trois fournisseurs IA ont échoué.",
      details: attempts
    });
  } catch (error) {
    return json(res, 500, {
      error: error?.message || "Erreur serveur IA."
    });
  }
}
