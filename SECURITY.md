# Security

Notato runs a server on your machine or your team's, holds screenshots of the apps you build, and hands work to coding agents that can change your code. We take reports about any of that seriously, and thank you for making one.

## Reporting a vulnerability

Please report it privately, through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([straight to the form](https://github.com/notatorg/notato/security/advisories/new)). Do not open a public issue, pull request or discussion about it.

It helps to include:

- what an attacker can do, and what they need first (a page open in your browser, a project token, a place on your network)
- the steps to reproduce it, or a proof of concept
- the version (`npx notato --version`, or the SDK's) and how Notato was run: `npx notato`, `notato dev`, `notato serve`, the Docker image, the browser extension or a mobile SDK

We will confirm we have it, keep you told as we work on a fix, and publish a GitHub security advisory when the fix is released. Tell us if you would like to be credited in it.

## Supported versions

Notato is before 1.0. Fixes go into the next release, so please check that the problem is still there in the latest one.

## What is in scope

Everything in this repository: the `notato` command and server, the board, MCP over stdio and HTTP, the dev tunnel, webhooks, the browser extension, the page script and every SDK. Some examples of what we would want to hear about:

- a web page, or anything else that is not you, reaching the server or acting as your agent
- a project token or the device token reaching anything other than its own server
- a screenshot, or text from a field or an element marked private, ending up in a note
- a way round the server's settings, such as screenshots being off or agents being turned off

The README's [Known limits](README.md#known-limits) and its notes on [MCP over HTTP](README.md#mcp-tools) and the [dev tunnel](README.md#phones-a-dev-tunnel) describe what Notato deliberately allows on your own machine. A report that something there is more open than it should be is welcome too.
