import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How a file is formatted, so code `init` adds does not trip the project's formatter or lint. */
export interface Style {
    semi: boolean;
    /** One level of indentation: two spaces, four spaces, or a tab. */
    indent: string;
    quote: '"' | "'";
    /** Lines longer than this get wrapped, as prettier would. */
    printWidth: number;
}

export const DEFAULT_STYLE: Style = { semi: false, indent: "  ", quote: '"', printWidth: 80 };

/** Reads semicolons, quotes and indentation from the file's own code. */
export function detectStyle(source: string): Style {
    const style = { ...DEFAULT_STYLE };

    const endings = [
        ...source.matchAll(/\bfrom\s+["'][^"'\n]+["'](;?)[ \t]*$/gm),
        ...source.matchAll(/^import\s+["'][^"'\n]+["'](;?)[ \t]*$/gm),
    ];
    if (endings.length > 0)
        style.semi = endings.filter((m) => m[1] === ";").length * 2 >= endings.length;

    const single =
        (source.match(/\bfrom\s+'/g) ?? []).length + (source.match(/^import\s+'/gm) ?? []).length;
    const double =
        (source.match(/\bfrom\s+"/g) ?? []).length + (source.match(/^import\s+"/gm) ?? []).length;
    if (single > double) style.quote = "'";

    let tabs = 0;
    const steps = new Map<number, number>();
    let previous = 0;
    for (const line of source.split("\n")) {
        if (line.trim() === "" || /^\s*(?:\*|\/\/)/.test(line)) continue;
        if (line.startsWith("\t")) tabs += 1;
        const indent = /^( *)\S/.exec(line)?.[1]?.length ?? 0;
        if (indent > previous)
            steps.set(indent - previous, (steps.get(indent - previous) ?? 0) + 1);
        previous = indent;
    }
    if (tabs > 0 && steps.size === 0) style.indent = "\t";
    else if (steps.size > 0) {
        const common = [...steps.entries()]
            .filter(([width]) => [2, 3, 4, 8].includes(width))
            .sort((a, b) => b[1] - a[1])[0];
        const width = common?.[0] ?? Math.min(...steps.keys());
        style.indent = " ".repeat(width);
    }
    return style;
}

const CONFIG_NAMES = [".prettierrc", ".prettierrc.json"];

/** The nearest prettier config above `dir`, when it is JSON (or the simple `key: value` YAML form). */
export function readPrettierConfig(dir: string): Partial<Style> | null {
    for (let current = dir, depth = 0; depth < 8; depth++, current = dirname(current)) {
        for (const name of CONFIG_NAMES) {
            const path = join(current, name);
            if (!existsSync(path)) continue;
            const raw = readFileSync(path, "utf8");
            let config: Record<string, unknown> | null = null;
            try {
                config = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                config = {};
                for (const line of raw.split("\n")) {
                    const m = /^\s*(\w+)\s*:\s*([^#\s]+)/.exec(line);
                    if (m)
                        config[m[1] as string] =
                            m[2] === "true"
                                ? true
                                : m[2] === "false"
                                  ? false
                                  : Number.isNaN(Number(m[2]))
                                    ? m[2]
                                    : Number(m[2]);
                }
            }
            const out: Partial<Style> = {};
            if (typeof config.semi === "boolean") out.semi = config.semi;
            if (typeof config.singleQuote === "boolean") out.quote = config.singleQuote ? "'" : '"';
            if (typeof config.printWidth === "number") out.printWidth = config.printWidth;
            if (config.useTabs === true) out.indent = "\t";
            else if (typeof config.tabWidth === "number") out.indent = " ".repeat(config.tabWidth);
            return out;
        }
        if (dirname(current) === current) break;
    }
    return null;
}

/** Prettier settings if the project has them (they are what `format:check` enforces), else what the file shows. */
export function resolveStyle(source: string, dir: string): Style {
    return { ...detectStyle(source), ...(readPrettierConfig(dir) ?? {}) };
}
