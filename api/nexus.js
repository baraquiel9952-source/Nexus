// api/nexus.js — Nexus v5
// Analizador de código multi-lenguaje por reglas/regex (sin IA):
// 1-6: análisis de código + paquetes reales (npm/PyPI/crates.io/Go/Packagist) — igual que v4
// 7:  métricas de calidad (anidación, complejidad ciclomática aproximada, funciones largas)
// 8:  diagnóstico de errores/stack traces
// 9:  comparador de código (diff)
// 10: búsqueda en Google (respaldo)
// 11: memoria de sesión vía Redis (Vercel Marketplace) — necesita configuración extra, ver sección
// 12: biblioteca de plantillas de código

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST permitido' });

    const { prompt, sessionId } = req.body;
    if (!prompt || prompt.trim().length < 2) {
        return res.status(400).json({ error: 'Mensaje demasiado corto.' });
    }

    try {
        const response = await processPrompt(prompt, sessionId);
        return res.status(200).json(response);
    } catch (err) {
        return res.status(500).json({ error: 'Error interno en Nexus.', detail: err.message });
    }
}

// ============================================================
// 1. EXTRACCIÓN DE CÓDIGO DEL MENSAJE
// ============================================================
function reflowMinifiedCode(text) {
    // Si no hay saltos de línea reales pero sí símbolos de bloque, probablemente
    // se perdieron los \n al copiar desde un bubble de chat en móvil.
    // Reinsertamos saltos aproximados para poder seguir dando número de línea.
    if (text.includes('\n')) return text;
    return text
        .replace(/\{/g, '{\n')
        .replace(/\}/g, '\n}\n')
        .replace(/;/g, ';\n')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .join('\n');
}

function hasCodeDensity(text) {
    const hits = (text.match(/[{};]|=>|:=/g) || []).length;
    return text.length > 100 && hits >= 6;
}

function extractCode(input) {
    const fenced = input.match(/```(\w*)\n?([\s\S]*?)```/);
    if (fenced) return fenced[2].trim();

    let candidate = input.trim();
    if (!candidate.includes('\n')) {
        const reflowed = reflowMinifiedCode(candidate);
        if (reflowed.split('\n').length >= 3) candidate = reflowed;
    }

    const lines = candidate.split('\n');
    if (lines.length >= 3) {
        const codeSignal = /[{};]|def |function |class |import |#include|<\?php|SELECT |<html|=>|:=/i;
        const hits = lines.filter(l => codeSignal.test(l)).length;
        if (hits >= Math.max(2, Math.ceil(lines.length * 0.3))) return candidate;
    }
    return null;
}

function extractAllCodeBlocks(input) {
    const blocks = [];
    const re = /```(\w*)\n?([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(input))) blocks.push(m[2].trim());
    return blocks;
}

// ============================================================
// 2. DETECCIÓN DE LENGUAJE
// ============================================================
const LANG_SIGNATURES = {
    json: [/^\s*[\{\[]/, /"\w+"\s*:/],
    sql: [/\bSELECT\b/i, /\bFROM\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i, /\bUPDATE\b.*\bSET\b/i],
    html: [/<!DOCTYPE html>/i, /<html[\s>]/i, /<div[\s>]/i, /<\/\w+>/],
    css: [/\{[^{}]*:[^{}]*;[^{}]*\}/, /^[.#]?[\w-]+\s*\{/m],
    rust: [/\bfn\s+\w+\s*\(/, /\blet\s+(mut\s+)?\w+/, /::\w/, /\bimpl\b/, /\buse\s+[\w:]+;/],
    python: [/\bdef\s+\w+\s*\(.*\):/, /\bimport\s+\w+/, /\belif\b/, /\bself\b/, /:\s*$/m],
    go: [/\bpackage\s+main/, /\bfunc\s+\w+\(/, /:=/, /\bfmt\./],
    ruby: [/\bdef\s+\w+/, /\bend\b\s*$/m, /\bputs\b/, /@\w+/],
    php: [/<\?php/, /\$\w+\s*=/, /\becho\b/],
    cpp: [/#include\s*</, /\bstd::/, /\bcout\s*<</, /\bint\s+main\s*\(/],
    csharp: [/\busing\s+System/, /\bConsole\.WriteLine\(/, /\bnamespace\s+\w+/],
    java: [/\bpublic\s+(class|static)\b/, /\bSystem\.out\.println\(/, /\bpublic\s+void\s+\w+\(/],
    typescript: [/:\s*(string|number|boolean|any|void)\b/, /\binterface\s+\w+/, /\bimport .* from ['"]/],
    javascript: [/\bfunction\b/, /=>/, /\bconsole\.log\(/, /\b(const|let|var)\s+\w+\s*=/],
};

function detectLanguage(code) {
    let best = { lang: 'generico', score: 0 };
    for (const [lang, patterns] of Object.entries(LANG_SIGNATURES)) {
        let score = 0;
        for (const p of patterns) if (p.test(code)) score++;
        if (score > best.score) best = { lang, score };
    }
    return best.lang;
}

// ============================================================
// 3. TOKENIZER: anula strings/comentarios antes de aplicar reglas
// ============================================================
function stripStringsAndComments(code, lang) {
    const cLike = ['javascript', 'typescript', 'java', 'csharp', 'cpp', 'go', 'php', 'css', 'rust'].includes(lang);
    const hashComment = ['python', 'ruby'].includes(lang);
    let out = '';
    let i = 0;
    const n = code.length;

    while (i < n) {
        const c = code[i], c2 = code[i + 1];

        if (cLike && c === '/' && c2 === '/') {
            while (i < n && code[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (cLike && c === '/' && c2 === '*') {
            out += '  '; i += 2;
            while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
                out += code[i] === '\n' ? '\n' : ' '; i++;
            }
            out += '  '; i += 2;
            continue;
        }
        if (hashComment && c === '#') {
            while (i < n && code[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += ' '; i++;
            while (i < n && code[i] !== quote) {
                if (code[i] === '\\') { out += '  '; i += 2; continue; }
                out += code[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += ' '; i++;
            continue;
        }
        out += c === '\n' ? '\n' : c;
        i++;
    }
    return out;
}

// ============================================================
// 4. CHEQUEOS UNIVERSALES
// ============================================================
function checkBrackets(stripped) {
    const stack = [];
    const closeToOpen = { ')': '(', ']': '[', '}': '{' };
    const opens = new Set(['(', '[', '{']);
    let line = 1;
    const issues = [];

    for (const ch of stripped) {
        if (ch === '\n') { line++; continue; }
        if (opens.has(ch)) stack.push({ ch, line });
        else if (closeToOpen[ch]) {
            const top = stack.pop();
            if (!top || top.ch !== closeToOpen[ch]) {
                issues.push({ line, severity: 'error', message: `Símbolo "${ch}" sin apertura correspondiente` });
            }
        }
    }
    for (const leftover of stack) {
        issues.push({ line: leftover.line, severity: 'error', message: `"${leftover.ch}" abierto y nunca cerrado` });
    }
    return issues;
}

function universalChecks(rawCode) {
    const issues = [];
    const lines = rawCode.split('\n');
    let hasTabs = false, hasSpaces = false;

    lines.forEach((line, idx) => {
        const n = idx + 1;
        if (/[ \t]+$/.test(line)) issues.push({ line: n, severity: 'info', message: 'Espacio en blanco al final de línea' });
        if (line.length > 120) issues.push({ line: n, severity: 'info', message: `Línea muy larga (${line.length} caracteres)` });
        if (/^\t/.test(line)) hasTabs = true;
        if (/^ {2,}\S/.test(line)) hasSpaces = true;
        if (/\b(TODO|FIXME|XXX)\b/.test(line)) issues.push({ line: n, severity: 'info', message: 'Comentario pendiente (TODO/FIXME) sin resolver' });
    });
    if (hasTabs && hasSpaces) {
        issues.push({ line: 0, severity: 'warning', message: 'Indentación mezclada: tabs y espacios en el mismo archivo' });
    }

    const secretPatterns = [
        { re: /(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i, msg: 'Posible API key hardcodeada' },
        { re: /AKIA[0-9A-Z]{16}/, msg: 'Posible AWS Access Key expuesta' },
        { re: /(password|contraseña|passwd)\s*[:=]\s*['"].{4,}['"]/i, msg: 'Contraseña hardcodeada en el código' },
        { re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, msg: 'Clave privada embebida en el código' },
    ];
    lines.forEach((line, idx) => {
        for (const { re, msg } of secretPatterns) {
            if (re.test(line)) issues.push({ line: idx + 1, severity: 'critico', message: msg });
        }
    });

    return issues;
}

// ============================================================
// 5. CHEQUEOS POR LENGUAJE (incluye reglas de seguridad ampliadas)
// ============================================================
function jsChecks(raw, stripped) {
    const issues = [];
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/(?<![=!<>])==(?!=)/.test(line)) issues.push({ line: n, severity: 'warning', message: 'Usa "===" en vez de "==" (comparación estricta)' });
        if (/(?<!=)!=(?!=)/.test(line)) issues.push({ line: n, severity: 'warning', message: 'Usa "!==" en vez de "!=" (comparación estricta)' });
        if (/\bvar\s+\w+/.test(line)) issues.push({ line: n, severity: 'info', message: 'Usa "let" o "const" en vez de "var"' });
        if (/\bconsole\.(log|debug)\(/.test(line)) issues.push({ line: n, severity: 'info', message: 'console.log de depuración olvidado' });
        if (/\bdebugger\b/.test(line)) issues.push({ line: n, severity: 'warning', message: 'Sentencia "debugger" olvidada' });
        if (/if\s*\(\s*[\w.]+\s*=(?!=)[^=]/.test(line)) issues.push({ line: n, severity: 'error', message: 'Posible bug: asignación "=" dentro de una condición (¿querías "=="?)' });
        if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) issues.push({ line: n, severity: 'warning', message: 'Bloque catch vacío: está silenciando el error' });
        if (/\beval\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'eval() es un riesgo de seguridad grave — evita ejecutar strings como código' });
        if (/\.innerHTML\s*=\s*(?!['"`])/.test(line)) issues.push({ line: n, severity: 'warning', message: 'innerHTML con una variable — riesgo de XSS si el contenido viene de un usuario. Usa textContent o sanitiza' });
        if (/document\.write\s*\(/.test(line)) issues.push({ line: n, severity: 'warning', message: 'document.write() es mala práctica y riesgo de XSS' });
    });
    const full = stripped.join('\n');
    if (/\.then\(/.test(full) && !/\.catch\(/.test(full)) {
        issues.push({ line: 0, severity: 'warning', message: 'Promise con .then() sin .catch() — errores no controlados' });
    }
    if (/\bawait\b/.test(full) && !/\btry\b/.test(full) && !/\.catch\(/.test(full)) {
        issues.push({ line: 0, severity: 'warning', message: 'Uso de "await" sin try/catch ni .catch() — errores no controlados' });
    }
    if (/Math\.random\(\)/.test(full) && /(token|password|contrase|secret|session)/i.test(full)) {
        issues.push({ line: 0, severity: 'critico', message: 'Math.random() no es criptográficamente seguro — no lo uses para tokens/contraseñas/sesiones. Usa crypto.randomBytes()' });
    }
    return issues;
}

function pyChecks(raw, stripped) {
    const issues = [];
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/^\s*except\s*:\s*$/.test(line)) issues.push({ line: n, severity: 'warning', message: 'except sin tipo — captura todo, incluso errores inesperados' });
        if (/def\s+\w+\([^)]*=\s*(\[\]|\{\})/.test(line)) issues.push({ line: n, severity: 'error', message: 'Argumento por defecto mutable ([] o {}) — bug clásico de Python' });
        if (/==\s*None\b/.test(line)) issues.push({ line: n, severity: 'info', message: 'Usa "is None" en vez de "== None"' });
        if (/==\s*(True|False)\b/.test(line)) issues.push({ line: n, severity: 'info', message: 'Comparación redundante con True/False, usa la variable directo' });
        if (/\bprint\(/.test(line)) issues.push({ line: n, severity: 'info', message: 'print() de depuración' });
        if (/\beval\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'eval() es un riesgo de seguridad grave' });
        if (/\bexec\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'exec() ejecuta código arbitrario — riesgo de seguridad' });
        if (/pickle\.loads?\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'pickle.loads() sobre datos no confiables permite ejecución de código arbitrario' });
        if (/subprocess\.\w+\([^)]*shell\s*=\s*True/.test(line)) issues.push({ line: n, severity: 'critico', message: 'shell=True con input externo es riesgo de inyección de comandos' });
        if (/hashlib\.(md5|sha1)\(/.test(line)) issues.push({ line: n, severity: 'warning', message: 'MD5/SHA1 son débiles para contraseñas — usa bcrypt/scrypt/argon2' });
    });
    return issues;
}

function javaChecks(raw, stripped) {
    const issues = [];
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) issues.push({ line: n, severity: 'warning', message: 'Bloque catch vacío: silencia el error' });
        if (/==\s*"/.test(line) || /"\s*==/.test(line)) issues.push({ line: n, severity: 'error', message: 'Compara Strings con .equals(), no con =="' });
        if (/System\.out\.println\(/.test(line)) issues.push({ line: n, severity: 'info', message: 'System.out.println de depuración' });
        if (/String\s+\w+\s*\+=/.test(line)) issues.push({ line: n, severity: 'info', message: 'Concatenar String con += en un loop es lento — usa StringBuilder' });
        if (/MessageDigest\.getInstance\(\s*["'](MD5|SHA-1)["']/i.test(line)) issues.push({ line: n, severity: 'warning', message: 'MD5/SHA-1 son débiles para contraseñas — usa bcrypt/PBKDF2/Argon2' });
        if (/Cipher\.getInstance\(\s*["'][^"']*(DES|ECB)[^"']*["']/.test(line)) issues.push({ line: n, severity: 'critico', message: 'DES o modo ECB son criptográficamente débiles — usa AES/GCM' });
    });
    return issues;
}

function csharpChecks(raw, stripped) {
    const issues = [];
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) issues.push({ line: n, severity: 'warning', message: 'Bloque catch vacío: silencia el error' });
        if (/Console\.WriteLine\(/.test(line)) issues.push({ line: n, severity: 'info', message: 'Console.WriteLine de depuración' });
    });
    return issues;
}

function cppChecks(raw, stripped) {
    const issues = [];
    const full = stripped.join('\n');
    const mallocCount = (full.match(/\b(malloc|calloc)\s*\(/g) || []).length;
    const freeCount = (full.match(/\bfree\s*\(/g) || []).length;
    if (mallocCount > freeCount) {
        issues.push({ line: 0, severity: 'warning', message: `Posible fuga de memoria: ${mallocCount} malloc/calloc vs ${freeCount} free` });
    }
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/\bgets\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'gets() es insegura (buffer overflow) — usa fgets()' });
        if (/\bstrcpy\s*\(/.test(line)) issues.push({ line: n, severity: 'warning', message: 'strcpy() sin límite — considera strncpy()' });
        if (/\bsprintf\s*\(/.test(line)) issues.push({ line: n, severity: 'warning', message: 'sprintf() sin límite — considera snprintf()' });
        if (/if\s*\(\s*[\w.]+\s*=(?!=)[^=]/.test(line)) issues.push({ line: n, severity: 'error', message: 'Posible bug: asignación "=" dentro de una condición' });
    });
    return issues;
}

function phpChecks(raw, stripped) {
    const issues = [];
    const full = stripped.join('\n');
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/(?<![=!<>])==(?!=)/.test(line)) issues.push({ line: n, severity: 'info', message: 'Considera "===" para comparación estricta' });
        if (/\bmysql_\w+\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'Función mysql_*() obsoleta (removida en PHP7+) — usa mysqli o PDO' });
        if (/\beval\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'eval() es un riesgo de seguridad grave' });
        if (/\$_(GET|POST|REQUEST)\[.+\]\s*\.\s*['"]/.test(line) || /['"].*\.\s*\$_(GET|POST|REQUEST)/.test(line)) {
            issues.push({ line: n, severity: 'critico', message: 'Posible SQL injection: input de usuario concatenado directo en un query' });
        }
    });
    if (/\b(md5|sha1)\s*\(/.test(full) && /pass|contrase/i.test(full)) {
        issues.push({ line: 0, severity: 'warning', message: 'MD5/SHA1 son débiles para contraseñas — usa password_hash()/password_verify()' });
    }
    return issues;
}

function goChecks(raw, stripped) {
    const issues = [];
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/\bfmt\.Println\(/.test(line)) issues.push({ line: n, severity: 'info', message: 'fmt.Println de depuración' });
    });
    const full = stripped.join('\n');
    const errDecls = (full.match(/(\w+,\s*)?err\s*:?=/g) || []).length;
    const ifErrCount = (full.match(/if\s+err\s*!=\s*nil/g) || []).length;
    if (errDecls > ifErrCount) {
        issues.push({ line: 0, severity: 'warning', message: `${errDecls - ifErrCount} posible(s) error(es) sin verificar con "if err != nil"` });
    }
    return issues;
}

function rustChecks(raw, stripped) {
    const issues = [];
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/\.unwrap\(\)/.test(line)) issues.push({ line: n, severity: 'info', message: '.unwrap() puede hacer panic — considera manejar el Result/Option (match, ?, unwrap_or)' });
        if (/\bunsafe\s*\{/.test(line)) issues.push({ line: n, severity: 'warning', message: 'Bloque unsafe — confirma que sea realmente necesario' });
        if (/\.clone\(\)/.test(line)) issues.push({ line: n, severity: 'info', message: '.clone() — revisa si de verdad necesitas copiar en vez de usar una referencia' });
    });
    return issues;
}

function rubyChecks(raw, stripped) {
    const issues = [];
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/\bputs\b/.test(line)) issues.push({ line: n, severity: 'info', message: 'puts de depuración' });
    });
    return issues;
}

function htmlChecks(raw) {
    const issues = [];
    raw.forEach((line, idx) => {
        const n = idx + 1;
        if (/<img(?![^>]*\balt=)[^>]*>/i.test(line)) issues.push({ line: n, severity: 'warning', message: 'Etiqueta <img> sin atributo alt (accesibilidad)' });
        if (/on(click|change|submit|load)\s*=/i.test(line)) issues.push({ line: n, severity: 'info', message: 'Handler de evento inline — mejor usar addEventListener' });
    });
    if (!/<html[^>]*\blang=/i.test(raw.join('\n'))) {
        issues.push({ line: 0, severity: 'info', message: 'Falta atributo lang en <html> (accesibilidad/SEO)' });
    }
    return issues;
}

function cssChecks(raw) {
    const issues = [];
    const full = raw.join('\n');
    const importantCount = (full.match(/!important/g) || []).length;
    if (importantCount >= 3) {
        issues.push({ line: 0, severity: 'info', message: `Uso frecuente de !important (${importantCount} veces) — señal de especificidad mal manejada` });
    }
    raw.forEach((line, idx) => {
        if (/\{\s*\}/.test(line)) issues.push({ line: idx + 1, severity: 'info', message: 'Regla CSS vacía' });
    });
    return issues;
}

function sqlChecks(raw) {
    const issues = [];
    const full = raw.join(' ').replace(/\s+/g, ' ');
    if (/\bUPDATE\b(?![\s\S]*\bWHERE\b)/i.test(full)) {
        issues.push({ line: 0, severity: 'critico', message: 'UPDATE sin WHERE — modificaría TODAS las filas de la tabla' });
    }
    if (/\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i.test(full)) {
        issues.push({ line: 0, severity: 'critico', message: 'DELETE sin WHERE — borraría TODA la tabla' });
    }
    if (/\bSELECT\s+\*/i.test(full)) {
        issues.push({ line: 0, severity: 'info', message: 'SELECT * — mejor especificar solo las columnas necesarias' });
    }
    return issues;
}

function jsonChecks(raw) {
    const issues = [];
    const text = raw.join('\n');
    if (/,\s*[\}\]]/.test(text)) {
        issues.push({ line: 0, severity: 'error', message: 'Coma sobrante antes de "}" o "]" (trailing comma) — inválido en JSON' });
    }
    try {
        JSON.parse(text);
    } catch (e) {
        issues.push({ line: 0, severity: 'error', message: `JSON inválido: ${e.message}` });
    }
    return issues;
}

const LANG_CHECKERS = {
    javascript: jsChecks, typescript: jsChecks,
    python: pyChecks, java: javaChecks, csharp: csharpChecks,
    cpp: cppChecks, php: phpChecks, go: goChecks, rust: rustChecks, ruby: rubyChecks,
    html: htmlChecks, css: cssChecks, sql: sqlChecks, json: jsonChecks,
};

const LANG_NAMES = {
    javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', java: 'Java',
    cpp: 'C/C++', csharp: 'C#', php: 'PHP', go: 'Go', rust: 'Rust', ruby: 'Ruby',
    html: 'HTML', css: 'CSS', sql: 'SQL', json: 'JSON', generico: 'código',
};

const SEVERITY_EMOJI = { critico: '🔴', error: '🟠', warning: '🟡', info: '🔵' };
const SEVERITY_ORDER = { critico: 0, error: 1, warning: 2, info: 3 };

// ============================================================
// 6. VERIFICACIÓN DE PAQUETES CONTRA REGISTRIES REALES
// ============================================================
const REGISTRY_LIMIT = 6;

async function fetchWithTimeout(url, ms = 3000, opts = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(t);
    }
}

function extractJsPackages(code) {
    const pkgs = new Set();
    const importRe = /import\s+(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]/g;
    const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = importRe.exec(code))) pkgs.add(m[1]);
    while ((m = requireRe.exec(code))) pkgs.add(m[1]);
    return [...pkgs]
        .filter(p => !p.startsWith('.') && !p.startsWith('/'))
        .map(p => p.startsWith('@') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0]);
}

const PY_STDLIB = new Set(['os', 'sys', 're', 'json', 'math', 'random', 'time', 'datetime', 'collections',
    'itertools', 'functools', 'typing', 'pathlib', 'logging', 'subprocess', 'threading', 'asyncio',
    'unittest', 'abc', 'io', 'enum', 'copy', 'string', 'http', 'urllib', 'sqlite3', 'csv', 'xml',
    'socket', 'struct', 'hashlib', 'base64', 'argparse', 'shutil', 'tempfile', 'glob', 'pickle',
    'queue', 'traceback', 'warnings', 'contextlib', 'dataclasses']);

function extractPyPackages(code) {
    const pkgs = new Set();
    const importRe = /^\s*import\s+([\w.]+)/gm;
    const fromRe = /^\s*from\s+([\w.]+)\s+import/gm;
    let m;
    while ((m = importRe.exec(code))) pkgs.add(m[1].split('.')[0]);
    while ((m = fromRe.exec(code))) pkgs.add(m[1].split('.')[0]);
    return [...pkgs].filter(p => !PY_STDLIB.has(p));
}

function extractGoPackages(code) {
    const found = [];
    const block = /import\s*\(([\s\S]*?)\)/.exec(code);
    if (block) {
        block[1].split('\n').forEach(l => {
            const mm = l.match(/"([^"]+)"/);
            if (mm) found.push(mm[1]);
        });
    }
    const singleRe = /import\s+"([^"]+)"/g;
    let m;
    while ((m = singleRe.exec(code))) found.push(m[1]);
    return [...new Set(found)].filter(p => p.split('/')[0].includes('.'));
}

const RUST_STD = new Set(['std', 'core', 'alloc', 'self', 'super', 'crate']);

function extractRustCrates(code) {
    const pkgs = new Set();
    const useRe = /\buse\s+([\w]+)(?:::|;)/g;
    let m;
    while ((m = useRe.exec(code))) pkgs.add(m[1]);
    return [...pkgs].filter(p => !RUST_STD.has(p));
}

function extractPhpNamespaces(code) {
    const pkgs = new Set();
    const useRe = /\buse\s+([\w\\]+)\s*;/g;
    let m;
    while ((m = useRe.exec(code))) {
        const parts = m[1].split('\\').filter(Boolean);
        if (parts.length >= 2) pkgs.add(`${parts[0]}/${parts[1]}`.toLowerCase());
    }
    return [...pkgs];
}

async function checkNpm(pkg) {
    try {
        const r = await fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
        if (!r.ok) return { pkg, found: false, ecosystem: 'npm' };
        const data = await r.json();
        const latest = data['dist-tags']?.latest;
        const deprecated = latest && data.versions?.[latest]?.deprecated;
        return { pkg, found: true, latest, deprecated: deprecated || null, ecosystem: 'npm' };
    } catch {
        return { pkg, found: null, ecosystem: 'npm' };
    }
}

async function checkPyPI(pkg) {
    try {
        const r = await fetchWithTimeout(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
        if (!r.ok) return { pkg, found: false, ecosystem: 'PyPI' };
        const data = await r.json();
        return { pkg, found: true, latest: data.info?.version, ecosystem: 'PyPI' };
    } catch {
        return { pkg, found: null, ecosystem: 'PyPI' };
    }
}

async function checkCratesIo(pkg) {
    const headers = { 'User-Agent': 'Nexus-Copiloto (github.com/baraquiel9952-source/Nexus)' };
    try {
        let r = await fetchWithTimeout(`https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}`, 3000, { headers });
        if (!r.ok) {
            const alt = pkg.replace(/_/g, '-');
            if (alt !== pkg) r = await fetchWithTimeout(`https://crates.io/api/v1/crates/${encodeURIComponent(alt)}`, 3000, { headers });
        }
        if (!r.ok) return { pkg, found: false, ecosystem: 'crates.io' };
        const data = await r.json();
        return { pkg, found: true, latest: data.crate?.newest_version, ecosystem: 'crates.io' };
    } catch {
        return { pkg, found: null, ecosystem: 'crates.io' };
    }
}

async function checkGoProxy(pkg) {
    try {
        const r = await fetchWithTimeout(`https://proxy.golang.org/${encodeURIComponent(pkg.toLowerCase())}/@latest`);
        if (!r.ok) return { pkg, found: false, ecosystem: 'Go' };
        const data = await r.json();
        return { pkg, found: true, latest: data.Version, ecosystem: 'Go' };
    } catch {
        return { pkg, found: null, ecosystem: 'Go' };
    }
}

async function checkPackagist(pkgGuess) {
    try {
        const r = await fetchWithTimeout(`https://repo.packagist.org/p2/${encodeURIComponent(pkgGuess)}.json`);
        if (!r.ok) return { pkg: pkgGuess, found: false, ecosystem: 'Packagist' };
        const data = await r.json();
        const versions = data.packages?.[pkgGuess];
        if (!versions || !versions.length) return { pkg: pkgGuess, found: false, ecosystem: 'Packagist' };
        return { pkg: pkgGuess, found: true, latest: versions[0].version, ecosystem: 'Packagist', guess: true };
    } catch {
        return { pkg: pkgGuess, found: null, ecosystem: 'Packagist' };
    }
}

const ECOSYSTEM_EXTRACTORS = {
    javascript: { extract: extractJsPackages, check: checkNpm },
    typescript: { extract: extractJsPackages, check: checkNpm },
    python: { extract: extractPyPackages, check: checkPyPI },
    go: { extract: extractGoPackages, check: checkGoProxy },
    rust: { extract: extractRustCrates, check: checkCratesIo },
    php: { extract: extractPhpNamespaces, check: checkPackagist },
};

async function checkPackages(lang, code) {
    const config = ECOSYSTEM_EXTRACTORS[lang];
    if (!config) return [];
    const names = config.extract(code).slice(0, REGISTRY_LIMIT);
    if (names.length === 0) return [];
    const results = await Promise.allSettled(names.map(n => config.check(n)));
    return results
        .map(r => (r.status === 'fulfilled' ? r.value : null))
        .filter(Boolean)
        .map(result => {
            if (result.found === false) {
                return { line: 0, severity: 'warning', message: `Paquete "${result.pkg}" no encontrado en ${result.ecosystem} — revisa el nombre` };
            }
            if (result.found === true) {
                if (result.deprecated) {
                    return { line: 0, severity: 'critico', message: `"${result.pkg}" está DEPRECADO en ${result.ecosystem}: ${result.deprecated}` };
                }
                const guessNote = result.guess ? ' (nombre inferido del namespace, verifica que sea el paquete correcto)' : '';
                return { line: 0, severity: 'info', message: `📦 ${result.pkg}@${result.latest} — última versión en ${result.ecosystem}${guessNote}` };
            }
            return null;
        })
        .filter(Boolean);
}

// ============================================================
// 7. MÉTRICAS DE CALIDAD (anidación, complejidad ciclomática aproximada, funciones largas)
// ============================================================
function maxNestingDepth(stripped, lang) {
    if (lang === 'python' || lang === 'ruby') {
        let max = 0, maxLine = 0;
        stripped.split('\n').forEach((l, idx) => {
            if (!l.trim()) return;
            const indent = l.match(/^ */)[0].length;
            const level = Math.floor(indent / 4);
            if (level > max) { max = level; maxLine = idx + 1; }
        });
        return { max, maxLine };
    }
    let depth = 0, max = 0, maxLine = 0, line = 1;
    for (const ch of stripped) {
        if (ch === '\n') line++;
        if (ch === '{') { depth++; if (depth > max) { max = depth; maxLine = line; } }
        if (ch === '}') depth--;
    }
    return { max, maxLine };
}

function analyzeFunctionSizes(stripped, lang) {
    if (!['javascript', 'typescript', 'java', 'csharp', 'cpp', 'go', 'rust', 'php'].includes(lang)) return [];
    const issues = [];
    const lines = stripped.split('\n');
    const funcSigRe = /\b(function\s*\w*\s*\(|=>\s*\{|\bfunc\s+\w+\(|\bfn\s+\w+\(|\w+\s*\([^;]*\)\s*\{)/;
    let depth = 0;
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hasSig = funcSigRe.test(line) && line.includes('{');
        for (const ch of line) {
            if (ch === '{') {
                depth++;
                if (hasSig) stack.push({ startLine: i + 1, atDepth: depth });
            }
            if (ch === '}') {
                if (stack.length && stack[stack.length - 1].atDepth === depth) {
                    const f = stack.pop();
                    const size = (i + 1) - f.startLine;
                    if (size > 50) {
                        issues.push({ line: f.startLine, severity: 'info', message: `Función de ~${size} líneas — considera dividirla en funciones más pequeñas` });
                    }
                }
                depth--;
            }
        }
    }
    return issues;
}

function qualityChecks(stripped, lang) {
    const issues = [];
    const { max, maxLine } = maxNestingDepth(stripped, lang);
    if (max > 4) {
        issues.push({ line: maxLine, severity: 'info', message: `Anidación profunda (nivel ${max}) — considera extraer funciones o usar "early return"` });
    }
    const decisionRe = /\b(if|else if|elif|for|while|case|catch|except)\b|&&|\|\|/g;
    const decisions = (stripped.match(decisionRe) || []).length;
    const nonEmptyLines = stripped.split('\n').filter(l => l.trim()).length;
    if (nonEmptyLines > 15 && decisions / nonEmptyLines > 0.35) {
        issues.push({ line: 0, severity: 'info', message: `Complejidad ciclomática aproximada alta (${decisions} puntos de decisión en ${nonEmptyLines} líneas) — considera simplificar` });
    }
    issues.push(...analyzeFunctionSizes(stripped, lang));
    return issues;
}

// ============================================================
// 8. DIAGNÓSTICO DE ERRORES / STACK TRACES
// ============================================================
const ERROR_PATTERNS = [
    { re: /TypeError:\s*Cannot read propert(?:y|ies) of undefined/i, lang: 'JavaScript', causa: 'Estás accediendo a una propiedad de algo que es undefined', fix: 'Revisa que la variable/objeto exista antes de usar la propiedad — usa optional chaining: obj?.propiedad' },
    { re: /TypeError:\s*Cannot read propert(?:y|ies) of null/i, lang: 'JavaScript', causa: 'Estás accediendo a una propiedad de algo que es null', fix: 'Verifica con "if (variable)" antes de acceder, o usa optional chaining' },
    { re: /ReferenceError:\s*\w+ is not defined/i, lang: 'JavaScript', causa: 'Usaste una variable que nunca declaraste o está fuera de alcance', fix: 'Revisa el nombre exacto (typo) y que esté declarada antes de usarla' },
    { re: /Unexpected token/i, lang: 'JavaScript', causa: 'Error de sintaxis — hay un carácter donde el parser no lo esperaba', fix: 'Revisa comas, llaves o paréntesis faltantes/sobrantes cerca de esa línea' },
    { re: /Maximum call stack size exceeded/i, lang: 'JavaScript', causa: 'Recursión infinita — una función se está llamando a sí misma sin condición de salida', fix: 'Revisa que tu función recursiva tenga un caso base que sí se cumpla' },
    { re: /Unhandled Promise Rejection|UnhandledPromiseRejectionWarning/i, lang: 'JavaScript/Node', causa: 'Una Promise fue rechazada y nadie la capturó con .catch() o try/catch', fix: 'Agrega .catch() al final de la cadena, o envuelve el await en try/catch' },
    { re: /EADDRINUSE/i, lang: 'Node.js', causa: 'El puerto que intentas usar ya está ocupado por otro proceso', fix: 'Cambia el puerto o cierra el proceso que lo está usando' },
    { re: /ENOENT.*no such file or directory/i, lang: 'Node.js', causa: 'Node intentó abrir un archivo/carpeta que no existe en esa ruta', fix: 'Verifica la ruta (relativa vs absoluta) y que el archivo exista' },
    { re: /Cannot find module/i, lang: 'Node.js', causa: 'Falta instalar una dependencia o la ruta del import está mal', fix: 'Corre npm install, o revisa que el nombre/ruta del import sea correcto' },
    { re: /NullPointerException/i, lang: 'Java', causa: 'Estás llamando un método o accediendo un campo de una referencia que es null', fix: 'Agrega una validación "if (objeto != null)" antes de usarlo' },
    { re: /ArrayIndexOutOfBoundsException/i, lang: 'Java', causa: 'Accediste a un índice de arreglo que no existe (fuera de rango)', fix: 'Revisa que el índice esté entre 0 y length-1' },
    { re: /ClassNotFoundException/i, lang: 'Java', causa: 'La JVM no encuentra la clase en el classpath', fix: 'Verifica el classpath/dependencias y que el nombre del paquete sea correcto' },
    { re: /ConcurrentModificationException/i, lang: 'Java', causa: 'Modificaste una colección mientras la recorrías con un for-each/Iterator', fix: 'Usa un Iterator explícito con .remove(), o recorre una copia de la lista' },
    { re: /NumberFormatException/i, lang: 'Java', causa: 'Intentaste convertir un String a número pero no tiene formato numérico válido', fix: 'Valida el String antes de Integer.parseInt()/Double.parseDouble(), o envuélvelo en try/catch' },
    { re: /StackOverflowError/i, lang: 'Java', causa: 'Recursión infinita o demasiado profunda', fix: 'Revisa el caso base de la recursión' },
    { re: /OutOfMemoryError/i, lang: 'Java', causa: 'La JVM se quedó sin memoria disponible', fix: 'Revisa fugas de memoria (colecciones que crecen sin límite) o aumenta -Xmx' },
    { re: /ClassCastException/i, lang: 'Java', causa: 'Intentaste convertir un objeto a un tipo con el que no es compatible', fix: 'Usa "instanceof" para verificar el tipo antes de castear' },
    { re: /IndentationError/i, lang: 'Python', causa: 'La indentación no es consistente (mezcla de tabs/espacios o nivel incorrecto)', fix: 'Revisa que uses el mismo tipo de indentación en todo el bloque (recomendado: 4 espacios)' },
    { re: /ModuleNotFoundError|ImportError/i, lang: 'Python', causa: 'Python no encuentra el módulo que intentas importar', fix: 'Instálalo con pip install <paquete>, o revisa el nombre exacto' },
    { re: /KeyError:/i, lang: 'Python', causa: 'Intentaste acceder a una clave de diccionario que no existe', fix: 'Usa dict.get("clave") en vez de dict["clave"], o valida con "in" antes' },
    { re: /AttributeError:\s*'NoneType' object has no attribute/i, lang: 'Python', causa: 'Una función regresó None y luego intentaste usar un método/atributo sobre ese None', fix: 'Revisa que la función que llamaste esté devolviendo el valor esperado' },
    { re: /ZeroDivisionError/i, lang: 'Python', causa: 'División entre cero', fix: 'Valida que el divisor no sea 0 antes de dividir' },
    { re: /RecursionError/i, lang: 'Python', causa: 'Recursión infinita o demasiado profunda', fix: 'Revisa el caso base de la función recursiva' },
    { re: /Fatal error:\s*Uncaught Error:\s*Call to undefined function/i, lang: 'PHP', causa: 'Llamaste una función que no existe o no está cargada', fix: 'Revisa el nombre exacto y que la extensión/archivo esté incluido' },
    { re: /Notice:\s*Undefined variable|Warning:\s*Undefined variable/i, lang: 'PHP', causa: 'Usaste una variable antes de asignarle un valor', fix: 'Inicializa la variable antes, o valida con isset()' },
    { re: /Parse error:\s*syntax error/i, lang: 'PHP', causa: 'Error de sintaxis — falta un punto y coma, llave, o hay un carácter inesperado', fix: 'Revisa la línea indicada y la anterior por símbolos faltantes' },
    { re: /syntax error at or near/i, lang: 'SQL', causa: 'Error de sintaxis en la consulta', fix: 'Revisa comas, comillas y palabras reservadas cerca del punto indicado' },
    { re: /duplicate key value violates unique constraint/i, lang: 'SQL', causa: 'Intentaste insertar un valor que ya existe en una columna UNIQUE/clave primaria', fix: 'Verifica si el registro ya existe antes de insertar (UPSERT/ON CONFLICT)' },
    { re: /foreign key constraint fails/i, lang: 'SQL', causa: 'Referencias una clave foránea que no existe en la tabla relacionada', fix: 'Verifica que el registro padre exista antes de insertar el hijo' },
    { re: /Segmentation fault/i, lang: 'C/C++', causa: 'Accediste a memoria que no te pertenece (puntero inválido, buffer overflow, etc.)', fix: 'Revisa punteros no inicializados, arreglos fuera de rango, o memoria ya liberada (use-after-free)' },
    { re: /undefined reference to/i, lang: 'C/C++', causa: 'El linker no encuentra la implementación de una función declarada', fix: 'Verifica que el .cpp con la implementación esté incluido en la compilación' },
    { re: /double free or corruption/i, lang: 'C/C++', causa: 'Llamaste free() dos veces sobre el mismo puntero', fix: 'Pon el puntero en NULL después de free() para evitar liberarlo otra vez' },
    { re: /CORS.*blocked|has been blocked by CORS policy/i, lang: 'Web', causa: 'El navegador bloqueó la petición porque el servidor no permite ese origen', fix: 'Agrega el header Access-Control-Allow-Origin en el servidor para ese dominio' },
    { re: /ECONNREFUSED/i, lang: 'Red', causa: 'La conexión fue rechazada — el servidor no está escuchando en esa dirección/puerto', fix: 'Verifica que el servidor esté corriendo y el puerto sea correcto' },
    { re: /timeout of \d+ms exceeded|ETIMEDOUT/i, lang: 'Red', causa: 'La petición tardó más de lo permitido y se canceló', fix: 'Revisa la conectividad, o aumenta el timeout si el servidor es lento por diseño' },
];

function diagnoseError(input) {
    const matches = ERROR_PATTERNS.filter(p => p.re.test(input));
    if (matches.length === 0) return null;
    const detalle = matches.map(m => `**${m.lang}**\n🩺 Causa probable: ${m.causa}\n🔧 Solución: ${m.fix}`).join('\n\n');
    return {
        response: `🚨 **Diagnóstico de error** — ${matches.length} patrón(es) reconocido(s):`,
        code_snippet: detalle,
    };
}

// ============================================================
// 9. COMPARADOR DE CÓDIGO (diff línea por línea)
// ============================================================
function diffLines(oldLines, newLines) {
    const n = oldLines.length, m = newLines.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const result = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (oldLines[i] === newLines[j]) { result.push({ type: 'same', line: oldLines[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ type: 'removed', line: oldLines[i] }); i++; }
        else { result.push({ type: 'added', line: newLines[j] }); j++; }
    }
    while (i < n) { result.push({ type: 'removed', line: oldLines[i] }); i++; }
    while (j < m) { result.push({ type: 'added', line: newLines[j] }); j++; }
    return result;
}

function buildDiffResponse(oldCode, newCode) {
    const diff = diffLines(oldCode.split('\n'), newCode.split('\n'));
    const added = diff.filter(d => d.type === 'added').length;
    const removed = diff.filter(d => d.type === 'removed').length;
    const detalle = diff.map(d => {
        const prefix = d.type === 'added' ? '+ ' : d.type === 'removed' ? '- ' : '  ';
        return prefix + d.line;
    }).join('\n');
    return {
        response: `🔀 **Comparación de código** — ${added} línea(s) agregada(s), ${removed} eliminada(s):`,
        code_snippet: detalle,
    };
}

// ============================================================
// 10. BÚSQUEDA EN GOOGLE (respaldo)
//    Requiere GOOGLE_API_KEY y GOOGLE_CX en Vercel (Project Settings → Environment Variables)
// ============================================================
async function searchGoogle(query, num = 4) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cx = process.env.GOOGLE_CX;
    if (!apiKey || !cx) return null;
    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&num=${num}&q=${encodeURIComponent(query)}`;
        const r = await fetchWithTimeout(url, 4000);
        if (!r.ok) return null;
        const data = await r.json();
        if (!data.items || data.items.length === 0) return [];
        return data.items.map(item => ({
            title: item.title,
            link: item.link,
            snippet: (item.snippet || '').replace(/\s+/g, ' ').trim(),
        }));
    } catch {
        return null;
    }
}

function formatSearchResults(results, query) {
    if (!results || results.length === 0) return null;
    const detalle = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   🔗 ${r.link}`).join('\n\n');
    return {
        response: `🔎 No tengo una plantilla lista para "${query}", así que busqué en Google — esto encontré:`,
        code_snippet: detalle,
    };
}

// ============================================================
// 11. MEMORIA DE SESIÓN (Redis vía Vercel Marketplace)
//    ⚠️ A diferencia de las secciones anteriores, esto SÍ necesita setup extra:
//    1) Vercel Dashboard → Storage → Marketplace Database Providers → Redis → Create,
//       y conectarlo a este proyecto
//    2) Revisa en Project Settings → Environment Variables los nombres EXACTOS que
//       Vercel inyectó (normalmente KV_REST_API_URL / KV_REST_API_TOKEN si el proveedor
//       es Upstash — confírmalo en tu dashboard, puede variar)
//    3) Agrega "@upstash/redis" en package.json (este proyecto pasa de 0 a 1 dependencia,
//       ya te dejo el package.json listo)
//    4) El index.html debe mandar un "sessionId" — ya está en la versión que te paso
// ============================================================
let redisClient = null;
async function getRedis() {
    if (redisClient) return redisClient;
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return null;
    try {
        const { Redis } = await import('@upstash/redis');
        redisClient = new Redis({ url, token });
        return redisClient;
    } catch {
        return null;
    }
}

async function saveSession(sessionId, data) {
    if (!sessionId) return;
    const redis = await getRedis();
    if (!redis) return;
    try {
        await redis.set(`nexus:session:${sessionId}`, JSON.stringify(data), { ex: 3600 });
    } catch { /* no interrumpe la respuesta si falla guardar */ }
}

async function loadSession(sessionId) {
    if (!sessionId) return null;
    const redis = await getRedis();
    if (!redis) return null;
    try {
        const raw = await redis.get(`nexus:session:${sessionId}`);
        if (!raw) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}

// ============================================================
// 12. BIBLIOTECA DE PLANTILLAS
// ============================================================
const TEMPLATE_LIBRARY = [
    {
        test: lower => lower.includes('extraer email') || lower.includes('extraer correo') ||
            lower.includes('extraer emails') || lower.includes('extract email'),
        reply: '📧 **Extractor de emails en JavaScript.** Encuentra todos los correos dentro de un texto:',
        code: `function extraerEmails(texto) {
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
    return texto.match(regex) || [];
}

// Uso:
// extraerEmails('Contacto: ana@correo.com o soporte@empresa.mx');
// -> ['ana@correo.com', 'soporte@empresa.mx']`,
    },
    {
        test: lower => lower.includes('validar email') || lower.includes('validar correo') ||
            lower.includes('email validation') || lower.includes('validate email'),
        reply: '📧 **Validación de email en JavaScript.** Aquí tienes una función robusta:',
        code: `function validateEmail(email) {
    const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
    if (!email || typeof email !== 'string') return false;
    if (email.length > 254) return false;
    const parts = email.split('@');
    if (parts.length !== 2) return false;
    const [local, domain] = parts;
    if (local.length === 0 || local.length > 64) return false;
    if (domain.length === 0 || domain.length > 255) return false;
    return emailRegex.test(email);
}`,
    },
    {
        test: lower => (lower.includes('jwt') || lower.includes('token')) &&
            (lower.includes('genera') || lower.includes('crear') || lower.includes('verificar') || lower.includes('firmar')),
        reply: '🔐 **JWT (HS256) con el módulo crypto nativo de Node** — sin librerías externas:',
        code: `const crypto = require('crypto');

function base64url(input) {
    return Buffer.from(input).toString('base64')
        .replace(/=/g, '').replace(/\\+/g, '-').replace(/\\//g, '_');
}

function generarJWT(payload, secreto, expiraEnSeg = 3600) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiraEnSeg };
    const encHeader = base64url(JSON.stringify(header));
    const encBody = base64url(JSON.stringify(body));
    const firma = crypto.createHmac('sha256', secreto).update(\`\${encHeader}.\${encBody}\`).digest('base64')
        .replace(/=/g, '').replace(/\\+/g, '-').replace(/\\//g, '_');
    return \`\${encHeader}.\${encBody}.\${firma}\`;
}

function verificarJWT(token, secreto) {
    const [encHeader, encBody, firma] = token.split('.');
    const firmaEsperada = crypto.createHmac('sha256', secreto).update(\`\${encHeader}.\${encBody}\`).digest('base64')
        .replace(/=/g, '').replace(/\\+/g, '-').replace(/\\//g, '_');
    if (firma !== firmaEsperada) throw new Error('Firma inválida');
    const payload = JSON.parse(Buffer.from(encBody, 'base64').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('Token expirado');
    return payload;
}`,
    },
    {
        test: lower => (lower.includes('conexion') || lower.includes('conectar')) && lower.includes('mysql'),
        reply: '🗄️ **Conexión a MySQL en Node.js** (paquete mysql2):',
        code: `// npm install mysql2
const mysql = require('mysql2/promise');

async function conectarDB() {
    const conexion = await mysql.createConnection({
        host: 'localhost',
        user: 'usuario',
        password: 'contraseña',
        database: 'nombre_db',
    });
    return conexion;
}

async function consultarUsuarios() {
    const db = await conectarDB();
    try {
        const [filas] = await db.execute('SELECT id, nombre FROM usuarios WHERE activo = ?', [1]);
        return filas;
    } finally {
        await db.end();
    }
}`,
    },
    {
        test: lower => lower.includes('sqlite') || (lower.includes('base de datos') && lower.includes('python')),
        reply: '🗄️ **Base de datos SQLite en Python** (librería estándar, sin instalar nada):',
        code: `import sqlite3

def conectar_db(ruta='datos.db'):
    conexion = sqlite3.connect(ruta)
    conexion.execute("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            activo INTEGER DEFAULT 1
        )
    """)
    return conexion

def obtener_usuarios_activos(conexion):
    cursor = conexion.execute("SELECT id, nombre FROM usuarios WHERE activo = ?", (1,))
    return cursor.fetchall()`,
    },
    {
        test: lower => (lower.includes('peticion') || lower.includes('llamada') || lower.includes('request') || lower.includes('http')) && lower.includes('python'),
        reply: '🌐 **Petición HTTP en Python** (urllib, sin dependencias):',
        code: `import urllib.request
import json

def peticion_get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as respuesta:
            return json.loads(respuesta.read().decode())
    except urllib.error.URLError as e:
        print(f"Error de red: {e}")
        return None

def peticion_post(url, datos):
    body = json.dumps(datos).encode()
    peticion = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(peticion, timeout=5) as respuesta:
            return json.loads(respuesta.read().decode())
    except urllib.error.URLError as e:
        print(f"Error de red: {e}")
        return None`,
    },
    {
        test: lower => (lower.includes('leer archivo') || lower.includes('archivo')) && lower.includes('java') && !lower.includes('javascript'),
        reply: '📄 **Leer un archivo en Java** (try-with-resources, se cierra automático):',
        code: `import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;

public class LectorArchivo {
    public static String leerArchivo(String ruta) {
        StringBuilder contenido = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new FileReader(ruta))) {
            String linea;
            while ((linea = br.readLine()) != null) {
                contenido.append(linea).append("\\n");
            }
        } catch (IOException e) {
            System.err.println("Error al leer el archivo: " + e.getMessage());
            return null;
        }
        return contenido.toString();
    }
}`,
    },
    {
        test: lower => lower.includes('http') && lower.includes('java') && !lower.includes('javascript'),
        reply: '🌐 **Petición HTTP en Java** (HttpURLConnection, sin librerías externas):',
        code: `import java.net.HttpURLConnection;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;

public class ClienteHttp {
    public static String peticionGet(String urlStr) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection con = (HttpURLConnection) url.openConnection();
        con.setRequestMethod("GET");
        con.setConnectTimeout(5000);

        StringBuilder respuesta = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(con.getInputStream()))) {
            String linea;
            while ((linea = br.readLine()) != null) respuesta.append(linea);
        } finally {
            con.disconnect();
        }
        return respuesta.toString();
    }
}`,
    },
    {
        test: lower => (lower.includes('leer archivo') || lower.includes('archivo')) &&
            (lower.includes('node') || lower.includes('javascript')),
        reply: '📄 **Leer/escribir archivos en Node.js:**',
        code: `const fs = require('fs').promises;

async function leerArchivo(ruta) {
    try {
        return await fs.readFile(ruta, 'utf8');
    } catch (error) {
        console.error('Error al leer:', error.message);
        return null;
    }
}

async function escribirArchivo(ruta, contenido) {
    try {
        await fs.writeFile(ruta, contenido, 'utf8');
        return true;
    } catch (error) {
        console.error('Error al escribir:', error.message);
        return false;
    }
}`,
    },
    {
        test: lower => (lower.includes('peticion') || lower.includes('llamada') || lower.includes('fetch')) &&
            !lower.includes('python') && !lower.includes('java '),
        reply: '🌐 **Petición HTTP en JavaScript con manejo de errores:**',
        code: `async function peticionGet(url) {
    try {
        const respuesta = await fetch(url);
        if (!respuesta.ok) throw new Error(\`Error \${respuesta.status}: \${respuesta.statusText}\`);
        return await respuesta.json();
    } catch (error) {
        console.error('Error en la petición:', error.message);
        return null;
    }
}`,
    },
];

// ============================================================
// 13. ORQUESTADOR DEL ANÁLISIS
// ============================================================
async function analyzeCode(code) {
    const lang = detectLanguage(code);
    const stripped = stripStringsAndComments(code, lang);
    const rawLines = code.split('\n');
    const strippedLines = stripped.split('\n');

    let issues = [...universalChecks(code)];
    if (!['html', 'css', 'json'].includes(lang)) {
        issues.push(...checkBrackets(stripped));
    }
    const checker = LANG_CHECKERS[lang];
    if (checker) {
        issues.push(...(['html', 'css', 'sql', 'json'].includes(lang)
            ? checker(rawLines)
            : checker(rawLines, strippedLines)));
    }
    if (!['html', 'css', 'json', 'sql'].includes(lang)) {
        issues.push(...qualityChecks(stripped, lang));
    }
    try {
        issues.push(...(await checkPackages(lang, code)));
    } catch { /* no interrumpe el resto del análisis */ }

    return { lang, issues };
}

async function buildAnalysisResponse(code) {
    const lineCount = code.split('\n').length;
    const { lang, issues } = await analyzeCode(code);
    const langName = LANG_NAMES[lang] || 'código';

    if (issues.length === 0) {
        return {
            response: `✅ **Analicé tu código (${langName}, ${lineCount} líneas)** y no encontré problemas de los que reviso automáticamente. Esto es un análisis por reglas/patrones, no un linter completo — no garantiza que esté 100% libre de bugs.`,
            code_snippet: '',
            lang, issues,
        };
    }

    issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line);
    const counts = { critico: 0, error: 0, warning: 0, info: 0 };
    issues.forEach(i => counts[i.severity]++);
    const resumen = Object.entries(counts).filter(([, c]) => c > 0).map(([sev, c]) => `${SEVERITY_EMOJI[sev]} ${c}`).join('  ');
    const detalle = issues.map(i => {
        const linea = i.line > 0 ? `Línea ${i.line}` : 'General';
        return `${SEVERITY_EMOJI[i.severity]} ${linea}: ${i.message}`;
    }).join('\n');

    return {
        response: `🔍 **Análisis de ${langName}** (${lineCount} líneas) — ${issues.length} punto(s) detectado(s):\n${resumen}`,
        code_snippet: detalle,
        lang, issues,
    };
}

// ============================================================
// 14. FLUJO PRINCIPAL
// ============================================================
function normalize(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function processPrompt(input, sessionId) {
    // Seguimiento sobre el último análisis de esta sesión: "¿y la línea 12?"
    const lineMatch = normalize(input).match(/\blinea\s+(\d+)\b/);
    if (lineMatch) {
        const prev = await loadSession(sessionId);
        if (prev && Array.isArray(prev.issues)) {
            const n = parseInt(lineMatch[1], 10);
            const found = prev.issues.filter(i => i.line === n);
            const base = { confidence: 0.85, timestamp: new Date().toISOString() };
            if (found.length) {
                return {
                    response: `📍 Línea ${n} de tu último análisis (${prev.lang}):`,
                    code_snippet: found.map(i => `${SEVERITY_EMOJI[i.severity]} ${i.message}`).join('\n'),
                    ...base,
                };
            }
            return { response: `📍 No detecté ningún problema en la línea ${n} de tu último análisis (${prev.lang}).`, code_snippet: '', ...base };
        }
        // sin sesión previa (o memoria no configurada) -> sigue el flujo normal
    }

    // Comparador: 2+ bloques de código = diff
    const blocks = extractAllCodeBlocks(input);
    if (blocks.length >= 2) {
        const { response, code_snippet } = buildDiffResponse(blocks[0], blocks[1]);
        return { response, code_snippet, confidence: 0.9, timestamp: new Date().toISOString() };
    }

    // Diagnóstico de error/stack trace (antes de tratarlo como código genérico)
    const errorDiag = diagnoseError(input);
    if (errorDiag) {
        return { ...errorDiag, confidence: 0.85, timestamp: new Date().toISOString() };
    }

    // Análisis de código pegado
    const code = extractCode(input);
    if (code && code.split('\n').length >= 2) {
        const { response, code_snippet, lang, issues } = await buildAnalysisResponse(code);
        await saveSession(sessionId, { code, lang, issues });
        return { response, code_snippet, confidence: 0.9, timestamp: new Date().toISOString() };
    }

    const lower = normalize(input);

    if (hasCodeDensity(input)) {
        return {
            response: '🔍 Esto parece código pero no logré separarlo en líneas (puede que se hayan perdido los saltos de línea al copiar/pegar). Intenta pegarlo de nuevo, o entre comillas triples ```.',
            code_snippet: '', confidence: 0.6, timestamp: new Date().toISOString(),
        };
    }

    for (const tpl of TEMPLATE_LIBRARY) {
        if (tpl.test(lower)) {
            return { response: tpl.reply, code_snippet: tpl.code, confidence: 0.88, timestamp: new Date().toISOString() };
        }
    }

    if (lower.includes('revisa') || lower.includes('revisar') || lower.includes('error') ||
        lower.includes('bug') || lower.includes('analiza') || lower.includes('corrige')) {
        return {
            response: '🔍 Pega el código directo y lo analizo automáticamente (bugs, seguridad, calidad, paquetes). También puedo diagnosticar un error/stack trace, o comparar dos versiones de código si pegas ambas.',
            code_snippet: '', confidence: 0.85, timestamp: new Date().toISOString(),
        };
    }

    const results = await searchGoogle(input);
    const formatted = formatSearchResults(results, input);
    if (formatted) return { ...formatted, confidence: 0.7, timestamp: new Date().toISOString() };

    return {
        response: `💡 **Recibido, Tarek.** No tengo una plantilla lista para eso todavía. Para ayudarte mejor:

- Pega el código directo y lo reviso línea por línea automáticamente
- Pega un error/stack trace y lo diagnostico
- Pega dos versiones de código (dos bloques \`\`\`) y las comparo
- O sé más específico (lenguaje + qué necesitas exactamente)`,
        code_snippet: '', confidence: 0.85, timestamp: new Date().toISOString(),
    };
}
