// api/nexus.js — Nexus v4
// Analizador de código multi-lenguaje por reglas/regex (sin IA) + verificación de paquetes
// contra registries reales: npm, PyPI, crates.io, proxy.golang.org, Packagist
// Cubre: JavaScript, TypeScript, Python, Java, C/C++, C#, PHP, Go, Rust, Ruby, HTML, CSS, SQL, JSON

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST permitido' });

    const { prompt } = req.body;
    if (!prompt || prompt.trim().length < 2) {
        return res.status(400).json({ error: 'Mensaje demasiado corto.' });
    }

    try {
        const response = await processPrompt(prompt);
        return res.status(200).json(response);
    } catch (err) {
        return res.status(500).json({ error: 'Error interno en Nexus.', detail: err.message });
    }
}

// ============================================================
// 1. EXTRACCIÓN DE CÓDIGO DEL MENSAJE
// ============================================================
function extractCode(input) {
    const fenced = input.match(/```(\w*)\n?([\s\S]*?)```/);
    if (fenced) return fenced[2].trim();

    const lines = input.split('\n');
    if (lines.length >= 3) {
        const codeSignal = /[{};]|def |function |class |import |#include|<\?php|SELECT |<html|=>|:=/i;
        const hits = lines.filter(l => codeSignal.test(l)).length;
        if (hits >= Math.max(2, Math.ceil(lines.length * 0.3))) return input.trim();
    }
    return null;
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
// 5. CHEQUEOS POR LENGUAJE
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
    });
    const full = stripped.join('\n');
    if (/\.then\(/.test(full) && !/\.catch\(/.test(full)) {
        issues.push({ line: 0, severity: 'warning', message: 'Promise con .then() sin .catch() — errores no controlados' });
    }
    if (/\bawait\b/.test(full) && !/\btry\b/.test(full) && !/\.catch\(/.test(full)) {
        issues.push({ line: 0, severity: 'warning', message: 'Uso de "await" sin try/catch ni .catch() — errores no controlados' });
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
    stripped.forEach((line, idx) => {
        const n = idx + 1;
        if (/(?<![=!<>])==(?!=)/.test(line)) issues.push({ line: n, severity: 'info', message: 'Considera "===" para comparación estricta' });
        if (/\bmysql_\w+\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'Función mysql_*() obsoleta (removida en PHP7+) — usa mysqli o PDO' });
        if (/\beval\s*\(/.test(line)) issues.push({ line: n, severity: 'critico', message: 'eval() es un riesgo de seguridad grave' });
        if (/\$_(GET|POST|REQUEST)\[.+\]\s*\.\s*['"]/.test(line) || /['"].*\.\s*\$_(GET|POST|REQUEST)/.test(line)) {
            issues.push({ line: n, severity: 'critico', message: 'Posible SQL injection: input de usuario concatenado directo en un query' });
        }
    });
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
//    (npm, PyPI, crates.io, proxy.golang.org, Packagist)
// ============================================================
const REGISTRY_LIMIT = 6; // tope de paquetes por análisis, para no exceder el tiempo de ejecución

async function fetchWithTimeout(url, ms = 3000, opts = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
        const r = await fetch(url, { ...opts, signal: controller.signal });
        return r;
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
      
