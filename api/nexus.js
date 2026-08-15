// api/nexus.js — Serverless function para Vercel
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Solo POST permitido' });
    }

    const { prompt } = req.body;
    if (!prompt || prompt.trim().length < 2) {
        return res.status(400).json({ error: 'Mensaje demasiado corto.' });
    }

    // --- LÓGICA DE NEXUS (copiloto) ---
    try {
        const response = await processPrompt(prompt);
        return res.status(200).json(response);
    } catch (err) {
        return res.status(500).json({ error: 'Error interno en Nexus.' });
    }
}

// Motor de razonamiento de Nexus
async function processPrompt(input) {
    const lower = input.toLowerCase();

    // Detección de intención
    let reply = '';
    let code_snippet = '';

    // 1. ¿Pide código?
    if (lower.includes('código') || lower.includes('función') || lower.includes('api') || lower.includes('componente')) {
        reply = '📦 **Aquí tienes una estructura posible.** Revisa y adapta.';
        code_snippet = `// Ejemplo para ${detectLanguage(input)}
function ejemplo(param) {
    try {
        // Lógica aquí
        return param * 2;
    } catch (e) {
        console.error('Error:', e);
        return null;
    }
}`;
    }
    // 2. ¿Pide revisión?
    else if (lower.includes('revisa') || lower.includes('error') || lower.includes('bug') || lower.includes('falla')) {
        reply = '🔍 **Análisis rápido:** Revisa estos puntos:';
        code_snippet = `⚠️ Posibles causas:
- Variable no definida en línea X
- Asincronía mal manejada (falta await)
- Tipo de dato incorrecto en la llamada API`;
    }
    // 3. ¿Pide arquitectura?
    else if (lower.includes('arquitectura') || lower.includes('estructura') || lower.includes('diseño')) {
        reply = '🏗️ **Estructura sugerida para tu proyecto:**';
        code_snippet = `📁 src/
  ├── components/
  ├── services/
  │   └── api.client.js
  ├── utils/
  └── index.js`;
    }
    // 4. Respuesta general (copiloto conversacional)
    else {
        reply = `💡 **Entendido, Tarek.** Esto es lo que veo desde mi perspectiva:
        
- El contexto que compartiste sugiere que estás trabajando en ${detectDomain(input)}.
- Recomiendo priorizar la claridad sobre la optimización prematura.
- ¿Quieres que profundice en algún aspecto específico?`;
    }

    return {
        response: reply,
        code_snippet: code_snippet,
        confidence: 0.82,
        timestamp: new Date().toISOString()
    };
}

// Helpers simples
function detectLanguage(input) {
    if (input.includes('java') || input.includes('android')) return 'Java/Android';
    if (input.includes('py') || input.includes('python')) return 'Python';
    if (input.includes('js') || input.includes('node')) return 'JavaScript/Node';
    return 'JavaScript';
}

function detectDomain(input) {
    if (input.includes('api') || input.includes('web service')) return 'APIs/backend';
    if (input.includes('app') || input.includes('android')) return 'apps móviles';
    if (input.includes('front') || input.includes('ui')) return 'frontend/interfaz';
    return 'desarrollo general';
}
