# Connect an app and an agent to your server

Once the server is running and you are signed in, an app (any Notato SDK) and a coding agent talk to it the same way they talk to the local `npx notato` server, with a project and a token.

## 1. Make a project

Sign in at your `NOTATO_PUBLIC_URL`, create a project, and open its **Connect** page. It makes an app token and an agent token in one click and shows the snippet for your framework. The two tokens do different jobs:

- the **app token** goes in your app. It can send notes (capture) and nothing else, so it is safe in code that ships to testers;
- the **agent token** goes to your coding agent and can read and update notes. Keep it out of any app you ship. [Capture behaviour](../../../docs/capture-contract.md) explains what each can do.

## 2. Point the SDK at your server

Every SDK takes the server's address and the app token. For the web SDKs:

```tsx
<Notato project="my-project" server="https://notato.example.com" token="..." />
```

(`VITE_NOTATO_SERVER` overrides `server`.) For the other SDKs see their READMEs, linked from the [main README](../../../README.md#add-it-to-your-app). A phone or tester's device cannot reach `localhost`, so give mobile and test builds the real HTTPS address from [Put Notato on the internet](reverse-proxy.md).

## 3. Allow your app's origin

A browser only sends notes from origins the project permits. In the project's settings, under **Browser origins**, add the address your app runs on (for example `http://localhost:5173` while developing and your staging address later). Native SDKs do not need this. A request that fails in the browser with a CORS error almost always means the origin is missing here.

## 4. Connect your agent

The Connect page also shows the command that adds Notato's tools to your coding agent. Agents use MCP at `<your server>/mcp` with the agent token; browser pages cannot use MCP. See [Works with your coding agent](../../../README.md#works-with-your-coding-agent) and [MCP tools](../../../README.md#mcp-tools).

## If it does not work

| You see | Check |
| --- | --- |
| 401 on every request | The token is for another project or server, was revoked, or is missing |
| CORS error in the browser console | The app's origin is not in the project's **Browser origins** |
| Notes send but screenshots are missing | Screenshots may be off for the project, or the S3 bucket is unreachable: `docker compose logs server` |
| Works on your machine, not on a phone | The SDK still points at `localhost`, or the server's address is not HTTPS |
