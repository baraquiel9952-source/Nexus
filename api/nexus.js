issues.push({ line: n, severity: 'info', message: 'Comparación redundante con True/False, usa la variable directo' });
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
    cpp: cppChecks, php: phpChecks, go: goChecks, ruby: rubyChecks,
    html: htmlChecks, css: cssChecks, sql: sqlChecks, json: jsonChecks,
};

const LANG_NAMES = {
    javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', java: 'Java',
    cpp: 'C/C++', csharp: 'C#', php: 'PHP', go: 'Go', ruby: 'Ruby',
    html: 'HTML', css: 'CSS', sql: 'SQL', json: 'JSON', generico: 'código',
};

const SEVERITY_EMOJI = { critico: '🔴', error: '🟠', warning: '🟡', info: '🔵' };
const SEVERITY_ORDER = { critico: 0, error: 1, warning: 2, info: 3 };

// ============================================================
// 6. ORQUESTADOR DEL ANÁLISIS
// ============================================================
function analyzeCode(code) {
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
    return { lang, issues };
}

function buildAnalysisResponse(code) {
    const lineCount = code.split('\n').length;
    const { lang, issues } = analyzeCode(code);
    const langName = LANG_NAMES[lang] || 'código';

    if (issues.length === 0) {
        return {
            response: `✅ **Analicé tu código (${langName}, ${lineCount} líneas)** y no encontré problemas de los que reviso automáticamente. Esto es un análisis por reglas/patrones, no un linter completo — no garantiza que esté 100% libre de bugs.`,
            code_snippet: '',
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
    };
}

// ============================================================
// 7. FLUJO PRINCIPAL
// ============================================================
async function processPrompt(input) {
    const code = extractCode(input);
    if (code && code.split('\n').length >= 2) {
        const { response, code_snippet } = buildAnalysisResponse(code);
        return { response, code_snippet, confidence: 0.9, timestamp: new Date().toISOString() };
    }

    const lower = input.toLowerCase();
    let reply = '';
    let code_snippet = '';

    if (lower.includes('validar email') || lower.includes('validar correo') ||
        lower.includes('email validation') || 
