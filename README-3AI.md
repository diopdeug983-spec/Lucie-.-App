# Lucide — backend 3 IA

Cette version conserve l'interface Lucide existante et branche `/api/lucide-ai` sur :

1. Gemini 2.5 Flash — principal
2. Groq `openai/gpt-oss-120b` — secours
3. Mistral — secours final (`mistral-small-latest` pour le texte, `pixtral-12b-2409` pour les images)

Variables Vercel nécessaires :

- GEMINI_API_KEY
- GROQ_API_KEY
- MISTRAL_API_KEY

Le backend renvoie directement les objets JSON attendus par l'interface actuelle, notamment :
- `niches`
- `idees`
- `score` / `subscores`
- `gagnant` / `score_a` / `score_b`

Aucune clé API n'est incluse dans ce ZIP.
