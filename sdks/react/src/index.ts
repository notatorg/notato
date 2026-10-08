// The React component, and everything the browser SDK offers (plugins, sinks, the controller), so a React app imports
// from one package. Bundlers drop what the app does not use.
export * from "@notato/browser";
export { Notato } from "./Notato.ts";
