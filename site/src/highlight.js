// A small syntax highlighter for the code on the landing page and in the docs: comments, strings, keywords, types.

const esc = (text) =>
    String(text).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
    );

const LANGS = {
    bash: [
        ["c", /#.*/],
        ["s", /"[^"\n]*"|'[^'\n]*'/],
        ["k", /\b(?:npx|npm|bun|claude|codex|gemini|docker|devtunnel|adb|dotnet|export)\b/],
    ],
    tsx: [
        ["c", /\/\/.*/],
        ["s", /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/],
        ["k", /\b(?:import|from|export|const|let|await|async|return|function|if|else|new)\b/],
        ["t", /<\/?[A-Z][\w.]*|\/>/],
        ["a", /\b[a-z]+(?==)/],
    ],
    js: [
        ["c", /\/\/.*/],
        ["s", /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/],
        ["k", /\b(?:await|async|const|let|return|function|new)\b/],
        ["a", /\b[a-z]+(?=:)/],
    ],
    json: [
        ["a", /"[^"\n]*"(?=\s*:)/],
        ["s", /"[^"\n]*"/],
        ["k", /\b(?:true|false|null)\b/],
    ],
    xml: [
        ["c", /<!--[\s\S]*?-->/],
        ["s", /"[^"\n]*"/],
        ["t", /<\/?[\w:.-]+|\/?>/],
        ["a", /\b[\w:.-]+(?==)/],
    ],
    toml: [
        ["c", /#.*/],
        ["t", /^\[[^\]\n]+\]/],
        ["s", /"[^"\n]*"/],
        ["a", /^[\w.-]+(?=\s*=)/],
    ],
    csharp: [
        ["c", /\/\/.*/],
        ["s", /"[^"\n]*"/],
        ["a", /#\w+/],
        [
            "k",
            /\b(?:using|var|new|if|else|return|public|private|static|class|async|await|true|false)\b/,
        ],
        ["t", /\b[A-Z]\w*(?=[.<(;])/],
    ],
    swift: [
        ["c", /\/\/.*/],
        ["s", /"[^"\n]*"/],
        ["a", /#\w+|@\w+/],
        ["k", /\b(?:import|struct|var|let|some|init|func|private|return|true|false)\b/],
        ["t", /\b[A-Z]\w*/],
    ],
    kotlin: [
        ["c", /\/\/.*/],
        ["s", /"[^"\n]*"/],
        ["k", /\b(?:class|override|fun|super|val|var|dependencies|import|true|false)\b/],
        ["t", /\b[A-Z]\w*/],
    ],
    dart: [
        ["c", /\/\/.*/],
        ["s", /'[^'\n]*'|"[^"\n]*"/],
        ["a", /@\w+/],
        [
            "k",
            /\b(?:import|void|const|final|var|return|class|extends|async|await|true|false|null)\b/,
        ],
        ["t", /\b[A-Z]\w*/],
    ],
};

/** Other names a fence or a page might give a language. */
const ALIASES = {
    ts: "tsx",
    typescript: "tsx",
    jsx: "tsx",
    javascript: "js",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    console: "bash",
    html: "xml",
    cs: "csharp",
    kt: "kotlin",
    kts: "kotlin",
};

/** Colours a `code` element whose `data-lang` names a language it knows, in place. */
export function highlight(node) {
    const lang = ALIASES[node.dataset.lang] ?? node.dataset.lang;
    const rules = LANGS[lang];
    if (!rules) return;
    const pattern = new RegExp(rules.map(([, re]) => `(${re.source})`).join("|"), "gm");
    const text = node.textContent;
    let html = "";
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const group = match.slice(1).findIndex((g) => g !== undefined);
        html += `${esc(text.slice(last, match.index))}<span class="${rules[group][0]}">${esc(match[0])}</span>`;
        last = match.index + match[0].length;
    }
    node.innerHTML = html + esc(text.slice(last));
}
