import { createInterface } from "node:readline/promises";

/** Asks the person to choose one of `choices`, and resolves to its index. */
export type Prompt = (question: string, choices: string[], defaultIndex: number) => Promise<number>;

/** Whether a person is there to answer: both stdin and stdout are a terminal. */
export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** A numbered question on the terminal. Enter takes the default. */
export const terminalPrompt: Prompt = async (question, choices, defaultIndex) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log(`\n${question}`);
        for (const [i, choice] of choices.entries())
            console.log(`  ${i + 1}) ${choice}${i === defaultIndex ? "  (default)" : ""}`);
        for (;;) {
            const answer = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
            if (answer === "") return defaultIndex;
            const n = Number(answer);
            if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
            console.log(`Enter a number from 1 to ${choices.length}.`);
        }
    } finally {
        rl.close();
    }
};

/** A yes-or-no question on the terminal. Anything but yes is no. */
export async function terminalConfirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
        rl.close();
    }
}
