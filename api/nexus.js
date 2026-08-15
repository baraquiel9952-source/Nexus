// api/nexus.js — VERSIÓN 3 (con CORS para frontend en Render)
export default async function handler(req, res) {
    // --- CORS: permitir que el frontend (Render) llame a este API (Vercel) ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    // El navegador manda un preflight OPTIONS antes del POST real
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Solo POST permitido' });
    }

    const { prompt } = req.body;
    if (!prompt || prompt.trim().length < 2) {
        return res.status(400).json({ error: 'Mensaje demasiado corto.' });
    }

    try {
        const response = await processPrompt(prompt);
        return res.status(200).json(response);
    } catch (err) {
        return res.status(500).json({ error: 'Error interno en Nexus.' });
    }
}

async function processPrompt(input) {
    const lower = input.toLowerCase();
    let reply = '';
    let code_snippet = '';

    // --- DETECTOR DE INTENCIÓN MEJORADO ---

    // 1. VALIDACIÓN DE EMAIL
    if (lower.includes('validar email') || lower.includes('validar correo') ||
        lower.includes('email validation') || lower.includes('validate email')) {
        reply = '📧 **Validación de email en JavaScript.** Aquí tienes una función robusta:';
        code_snippet = `function validateEmail(email) {
    // Expresión regular estándar para emails
    const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

    if (!email || typeof email !== 'string') return false;
    if (email.length > 254) return false; // Límite RFC 5321

    const parts = email.split('@');
    if (parts.length !== 2) return false;

    const [local, domain] = parts;
    if (local.length === 0 || local.length > 64) return false;
    if (domain.length === 0 || domain.length > 255) return false;

    // Validación final con regex
    return emailRegex.test(email);
}

// Uso:
// validateEmail('usuario@ejemplo.com'); // true
// validateEmail('mal@formato'); // false`;
    }

    // 2. FUNCIÓN GENÉRICA (cuando pide "función" o "código" sin más)
    else if (lower.includes('función') || lower.includes('código') || lower.includes('api')) {
        reply = '📦 **Entendido. Dame más contexto:** ¿Qué tipo de función necesitas?';
        code_snippet = `// Ejemplo de estructura básica
function nombreDeTuFuncion(parametros) {
    try {
        // Lógica aquí
        return resultado;
    } catch (error) {
        console.error('Error en nombreDeTuFuncion:', error);
        return null;
    }
}`;
    }

    // 3. REVISIÓN DE CÓDIGO (si pega código)
    else if (lower.includes('revisa') || lower.includes('error') || lower.includes('bug')) {
        reply = '🔍 **Análisis rápido.** Comparte el código exacto para revisarlo línea por línea.';
        code_snippet = `⚠️ Cosas que revisar siempre:
- Variables declaradas correctamente
- Promesas con async/await o .then()
- Manejo de errores con try/catch
- Tipos de datos en las comparaciones`;
    }

    // 4. RESPUESTA POR DEFECTO (cuando no detecta patrón claro)
    else {
        reply = `💡 **Recibido, Tarek.** Para darte una respuesta útil, necesito más contexto:

- ¿Estás en un proyecto de frontend, backend o móvil?
- ¿Qué problema concreto quieres resolver?
- ¿Tienes código existente que compartir?

Cuéntame con detalle y ajustaré mi respuesta.`;
    }

    return {
        response: reply,
        code_snippet: code_snippet,
        confidence: 0.85,
        timestamp: new Date().toISOString()
    };
}
