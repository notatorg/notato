// What a program built on the notato command may use: the command itself, to hand it whatever it does not answer
// first, and the pieces a command of its own reads its options and stops with, so it behaves as `notato` does.

export { main } from "./main.ts";
export { localServer, parsePort } from "./options.ts";
export { stopOnSignals } from "./process.ts";
