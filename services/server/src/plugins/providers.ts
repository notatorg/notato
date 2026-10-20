import { createHmac, createSign } from "node:crypto";
import type { Connection, Destination, Payload, Result } from "./model.ts";
import { type Http, outboundUrl, publicFetch } from "./transport.ts";

/** What to tell a person when the other tool answered with an error: what it likely means and what to try. */
export function refusal(status: number): string {
    if (status === 429) return "Provider rate limit reached.";
    if (status === 401)
        return "The provider did not accept that credential (401). Check it was copied in full, has not expired and was made for the right account.";
    if (status === 403)
        return "The provider accepted the credential but refused access (403). Check its permissions and that it can reach the repository, project or channel you chose.";
    if (status === 404)
        return "The provider could not find that (404). Check the name you entered, and that the credential has access to it.";
    if (status >= 500) return `The provider had a problem (${status}). Try again in a few minutes.`;
    return `The provider refused the request (${status}).`;
}
export class ProviderError extends Error {
    constructor(
        readonly disposition: "retry" | "review" | "failed",
        message: string,
        readonly status?: number
    ) {
        super(message);
    }
}
export interface Credential {
    token: string;
    installationId?: string;
    refreshToken?: string;
    expiresAt?: number;
    oauth?: boolean;
    repositories?: string[];
}
const html = (value: string) =>
    value.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c
    );
export class Providers {
    constructor(private http: Http = publicFetch) {}
    private async call(
        url: string,
        init: RequestInit,
        writing = false
    ): Promise<Record<string, unknown>> {
        let response: Response;
        try {
            response = await this.http(url, { ...init, redirect: "manual" });
        } catch {
            throw new ProviderError(
                writing ? "review" : "retry",
                writing
                    ? "Delivery is uncertain. Check the destination before retrying."
                    : "The provider could not be reached."
            );
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new ProviderError(
                response.status === 429
                    ? "retry"
                    : response.status >= 500
                      ? writing
                          ? "review"
                          : "retry"
                      : "failed",
                refusal(response.status),
                response.status
            );
        }
        const value = await response.text();
        if (!value) return {};
        try {
            return JSON.parse(value) as Record<string, unknown>;
        } catch {
            if (!writing)
                throw new ProviderError("failed", "The provider returned an invalid response.");
            return {};
        }
    }
    private async githubToken(c: Credential, repository?: string, pulls?: "read" | "write") {
        if (!c.installationId) return c.token;
        if (
            repository &&
            !c.repositories?.some((r) => r.toLowerCase() === repository.toLowerCase())
        )
            throw new ProviderError(
                "failed",
                "This repository was not authorized by the person connecting the GitHub App."
            );
        const app = process.env.NOTATO_GITHUB_APP_ID,
            key = process.env.NOTATO_GITHUB_APP_PRIVATE_KEY;
        if (!app || !key) throw new ProviderError("failed", "GitHub App access is not configured.");
        const now = Math.floor(Date.now() / 1000);
        const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
        const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: app })}`;
        const signer = createSign("RSA-SHA256");
        signer.update(input);
        const jwt = `${input}.${signer.sign(key.replace(/\\n/g, "\n")).toString("base64url")}`;
        const result = await this.call(
            `https://api.github.com/app/installations/${c.installationId}/access_tokens`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "Notato",
                },
                body: JSON.stringify({
                    permissions: {
                        issues: "write",
                        metadata: "read",
                        ...(pulls ? { pull_requests: pulls } : {}),
                    },
                    ...(repository ? { repositories: [repository.split("/")[1]] } : {}),
                }),
            }
        );
        if (typeof result.token !== "string")
            throw new ProviderError("failed", "GitHub App access could not be renewed.");
        return result.token;
    }
    async pullRequest(c: Credential, repository: string, number: number) {
        const value = await this.call(
            `https://api.github.com/repos/${repository}/pulls/${number}`,
            {
                headers: {
                    Authorization: `Bearer ${await this.githubToken(c, repository, "read")}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "Notato",
                },
            }
        );
        const head = value.head as { sha?: unknown } | undefined,
            base = value.base as { sha?: unknown; repo?: { full_name?: unknown } } | undefined;
        if (
            value.number !== number ||
            typeof value.title !== "string" ||
            !["open", "closed"].includes(String(value.state)) ||
            typeof head?.sha !== "string" ||
            !/^[a-f0-9]{40,64}$/i.test(head.sha) ||
            typeof base?.sha !== "string" ||
            !/^[a-f0-9]{40,64}$/i.test(base.sha) ||
            String(base.repo?.full_name).toLowerCase() !== repository.toLowerCase()
        )
            throw new ProviderError("failed", "GitHub returned an invalid pull request.");
        return {
            repository,
            number,
            title: value.title.slice(0, 300),
            url: `https://github.com/${repository}/pull/${number}`,
            headSha: head.sha,
            baseSha: base.sha,
            state: String(value.state),
            merged: value.merged === true,
            checkedAt: new Date().toISOString(),
        };
    }
    async publishPullRequestReview(
        c: Credential,
        repository: string,
        number: number,
        commit: string,
        body: string
    ) {
        const value = await this.call(
            `https://api.github.com/repos/${repository}/pulls/${number}/reviews`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${await this.githubToken(c, repository, "write")}`,
                    Accept: "application/vnd.github+json",
                    "Content-Type": "application/json",
                    "User-Agent": "Notato",
                },
                body: JSON.stringify({ commit_id: commit, body, event: "COMMENT" }),
            },
            true
        );
        if (typeof value.id !== "number" || !Number.isSafeInteger(value.id))
            throw new ProviderError(
                "review",
                "GitHub may have accepted the review. Check the PR before sending it again."
            );
        return {
            url: `https://github.com/${repository}/pull/${number}#pullrequestreview-${value.id}`,
        };
    }
    async findPullRequestReview(
        c: Credential,
        repository: string,
        number: number,
        operation: string,
        commit: string
    ) {
        const value = await this.call(
            `https://api.github.com/repos/${repository}/pulls/${number}/reviews?per_page=100`,
            {
                headers: {
                    Authorization: `Bearer ${await this.githubToken(c, repository, "read")}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "Notato",
                },
            }
        );
        if (!Array.isArray(value))
            throw new ProviderError("failed", "GitHub returned an invalid review list.");
        const review = value.find(
            (r: Record<string, unknown>) =>
                typeof r.body === "string" &&
                r.body.includes(`<!-- notato-review:${operation} -->`) &&
                r.commit_id === commit &&
                typeof r.id === "number"
        );
        return review
            ? {
                  url: `https://github.com/${repository}/pull/${number}#pullrequestreview-${review.id}`,
              }
            : null;
    }
    async verify(connection: Pick<Connection, "provider">, credential: Credential) {
        const token = credential.token;
        if (["teams", "webhook"].includes(connection.provider)) {
            const url = outboundUrl(token);
            if (
                connection.provider === "teams" &&
                !/(?:^|\.)(?:api\.powerplatform\.com|environment\.api\.powerplatform\.com|webhook\.office\.com)$/.test(
                    url.hostname
                )
            )
                throw new ProviderError("failed", "Use the HTTPS URL from your Teams Workflow.");
            return;
        }
        if (connection.provider === "github") {
            if (credential.installationId) {
                // The user's GitHub credential must independently authorize this installation before we retain its id.
                const allowed: string[] = [];
                for (let page = 1; page <= 10; page++) {
                    const response = await this.call(
                        `https://api.github.com/user/installations/${credential.installationId}/repositories?per_page=100&page=${page}`,
                        { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Notato" } }
                    );
                    const repositories = response.repositories;
                    if (!Array.isArray(repositories))
                        throw new ProviderError(
                            "failed",
                            "GitHub did not confirm the repositories available to this account."
                        );
                    for (const r of repositories)
                        if (typeof r.full_name === "string") allowed.push(r.full_name);
                    if (repositories.length < 100) break;
                }
                if (!allowed.length)
                    throw new ProviderError(
                        "failed",
                        "This account has no repositories in that installation."
                    );
                credential.repositories = allowed;
                await this.githubToken(credential);
            } else
                await this.call("https://api.github.com/user", {
                    headers: { Authorization: `Bearer ${token}`, "User-Agent": "Notato" },
                });
        } else if (connection.provider === "slack") {
            const result = await this.call("https://slack.com/api/auth.test", {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (result.ok !== true)
                throw new ProviderError("failed", "Slack did not accept this connection.");
        } else if (connection.provider === "linear") {
            const result = await this.call("https://api.linear.app/graphql", {
                method: "POST",
                headers: {
                    Authorization: credential.oauth ? `Bearer ${token}` : token,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query: "query { viewer { id } }" }),
            });
            if (result.errors || !result.data)
                throw new ProviderError("failed", "Linear did not accept this connection.");
        } else if (connection.provider === "gitlab")
            await this.call("https://gitlab.com/api/v4/user", {
                headers: { Authorization: `Bearer ${token}` },
            });
        // Azure access is checked against the selected organization/project when an action is saved.
    }
    async validateDestination(d: Destination, c: Credential) {
        if (d.provider === "github")
            await this.call(`https://api.github.com/repos/${d.repository}`, {
                headers: {
                    Authorization: `Bearer ${await this.githubToken(c, d.repository)}`,
                    "User-Agent": "Notato",
                },
            });
        if (d.provider === "azure")
            await this.call(
                `https://dev.azure.com/${d.organization}/${encodeURIComponent(d.project)}/_apis/wit/workitemtypes/${encodeURIComponent(d.workItemType)}?api-version=7.1`,
                { headers: { Authorization: `Bearer ${c.token}` } }
            );
        if (d.provider === "gitlab")
            await this.call(`https://gitlab.com/api/v4/projects/${encodeURIComponent(d.project)}`, {
                headers: { Authorization: `Bearer ${c.token}` },
            });
    }
    async destinations(
        provider: Connection["provider"],
        c: Credential,
        organization?: string,
        project?: string
    ): Promise<{ id: string; name: string }[]> {
        if (provider === "github") {
            const r = await this.call(
                c.installationId
                    ? "https://api.github.com/installation/repositories?per_page=100"
                    : "https://api.github.com/user/repos?per_page=100&sort=updated",
                {
                    headers: {
                        Authorization: `Bearer ${await this.githubToken(c)}`,
                        "User-Agent": "Notato",
                    },
                }
            );
            const repos = Array.isArray(r) ? r : r.repositories;
            return Array.isArray(repos)
                ? repos
                      .filter(
                          (v) =>
                              typeof v.full_name === "string" &&
                              (!c.installationId || c.repositories?.includes(v.full_name))
                      )
                      .map((v) => ({ id: v.full_name, name: v.full_name }))
                : [];
        }
        if (provider === "slack") {
            const r = await this.call(
                "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true",
                { headers: { Authorization: `Bearer ${c.token}` } }
            );
            if (r.ok !== true)
                throw new ProviderError(
                    "failed",
                    "Channel discovery needs channels:read and groups:read. You can also enter a channel ID."
                );
            return Array.isArray(r.channels)
                ? r.channels
                      .filter((v) => v.is_member)
                      .map((v) => ({ id: String(v.id), name: `#${v.name}` }))
                : [];
        }
        if (provider === "linear") {
            const r = await this.call("https://api.linear.app/graphql", {
                method: "POST",
                headers: {
                    Authorization: c.oauth ? `Bearer ${c.token}` : c.token,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query: "query { teams(first:100) { nodes { id name } } }" }),
            });
            const nodes = (r.data as { teams?: { nodes?: { id: string; name: string }[] } })?.teams
                ?.nodes;
            return nodes ?? [];
        }
        if (provider === "gitlab") {
            const r = await this.call(
                "https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at",
                { headers: { Authorization: `Bearer ${c.token}` } }
            );
            return Array.isArray(r)
                ? r.map((v) => ({ id: String(v.id), name: String(v.name_with_namespace) }))
                : [];
        }
        if (provider === "azure" && organization) {
            const path = project
                ? `${encodeURIComponent(project)}/_apis/wit/workitemtypes`
                : "_apis/projects";
            const r = await this.call(
                `https://dev.azure.com/${organization}/${path}?api-version=7.1`,
                { headers: { Authorization: `Bearer ${c.token}` } }
            );
            return Array.isArray(r.value)
                ? r.value.map((v) => ({ id: String(v.name), name: String(v.name) }))
                : [];
        }
        return [];
    }
    async link(d: Destination, c: Credential, value: string): Promise<Result> {
        const url = outboundUrl(value);
        if (d.provider === "github") {
            const expected = new RegExp(
                `^/${d.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/(\\d+)$`
            );
            const number = expected.exec(url.pathname)?.[1];
            if (url.hostname !== "github.com" || !number)
                throw new ProviderError(
                    "failed",
                    "Select an issue in this action's GitHub repository."
                );
            const r = await this.call(
                `https://api.github.com/repos/${d.repository}/issues/${number}`,
                {
                    headers: {
                        Authorization: `Bearer ${await this.githubToken(c, d.repository)}`,
                        "User-Agent": "Notato",
                    },
                }
            );
            if (r.pull_request)
                throw new ProviderError("failed", "Choose an issue rather than a pull request.");
            return this.result(r.html_url, r.number);
        }
        if (d.provider === "gitlab") {
            const number = /\/-\/issues\/(\d+)$/.exec(url.pathname)?.[1];
            if (url.hostname !== "gitlab.com" || !number)
                throw new ProviderError("failed", "Choose a GitLab issue.");
            const r = await this.call(
                `https://gitlab.com/api/v4/projects/${encodeURIComponent(d.project)}/issues/${number}`,
                { headers: { Authorization: `Bearer ${c.token}` } }
            );
            if (r.web_url !== url.href)
                throw new ProviderError(
                    "failed",
                    "Select an issue in this action's GitLab project."
                );
            return this.result(r.web_url, r.iid);
        }
        if (d.provider === "azure") {
            const number = /\/_workitems\/edit\/(\d+)\/?$/.exec(url.pathname)?.[1];
            if (
                url.hostname !== "dev.azure.com" ||
                !number ||
                decodeURIComponent(url.pathname.split("/")[1] ?? "") !== d.organization
            )
                throw new ProviderError(
                    "failed",
                    "Choose a work item in this action's Azure DevOps organization."
                );
            const r = await this.call(
                `https://dev.azure.com/${d.organization}/${encodeURIComponent(d.project)}/_apis/wit/workitems/${number}?api-version=7.1`,
                { headers: { Authorization: `Bearer ${c.token}` } }
            );
            const fields = r.fields as Record<string, unknown> | undefined;
            if (String(fields?.["System.TeamProject"]).toLowerCase() !== d.project.toLowerCase())
                throw new ProviderError("failed", "Select a work item in this action's project.");
            return this.result((r._links as { html?: { href?: string } })?.html?.href, r.id);
        }
        if (d.provider === "linear") {
            if (url.hostname !== "linear.app")
                throw new ProviderError("failed", "Choose a Linear issue.");
            const id = /\/issue\/([a-z]+-\d+)/i.exec(url.pathname)?.[1];
            if (!id) throw new ProviderError("failed", "Choose a Linear issue.");
            const r = await this.call("https://api.linear.app/graphql", {
                method: "POST",
                headers: {
                    Authorization: c.oauth ? `Bearer ${c.token}` : c.token,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: "query Issue($id:String!){issue(id:$id){url identifier team{id}}}",
                    variables: { id },
                }),
            });
            const issue = (
                r.data as { issue?: { url: string; identifier: string; team: { id: string } } }
            )?.issue;
            if (r.errors || !issue || issue.team.id !== d.team)
                throw new ProviderError("failed", "Select an issue in this action's Linear team.");
            return this.result(issue.url, issue.identifier);
        }
        throw new ProviderError("failed", "This action does not link issues.");
    }
    async execute(
        d: Destination,
        credential: Credential,
        p: Payload,
        operation: string
    ): Promise<Result> {
        const json = (token: string, body: unknown): RequestInit => ({
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "Notato",
                "Idempotency-Key": operation,
            },
            body: JSON.stringify(body),
        });
        const marker = `<!-- notato:${operation} -->`;
        if (d.provider === "github") {
            const result = await this.call(
                `https://api.github.com/repos/${d.repository}/issues`,
                json(await this.githubToken(credential, d.repository), {
                    title: p.title,
                    body: `${p.text}\n\n${marker}`,
                    labels: d.labels,
                    ...(d.assignee ? { assignees: [d.assignee] } : {}),
                }),
                true
            );
            return this.result(result.html_url, result.number);
        }
        if (d.provider === "azure") {
            const body = [
                { op: "add", path: "/fields/System.Title", value: p.title },
                {
                    op: "add",
                    path: "/fields/System.Description",
                    value: `<pre>${html(p.text)}</pre>${marker}`,
                },
                ...(d.area ? [{ op: "add", path: "/fields/System.AreaPath", value: d.area }] : []),
                ...(d.assignee
                    ? [{ op: "add", path: "/fields/System.AssignedTo", value: d.assignee }]
                    : []),
            ];
            const init = json(credential.token, body);
            init.headers = { ...init.headers, "Content-Type": "application/json-patch+json" };
            const r = await this.call(
                `https://dev.azure.com/${d.organization}/${encodeURIComponent(d.project)}/_apis/wit/workitems/$${encodeURIComponent(d.workItemType)}?api-version=7.1`,
                init,
                true
            );
            const links = r._links as { html?: { href?: string } } | undefined;
            return this.result(links?.html?.href, r.id);
        }
        if (d.provider === "gitlab") {
            const r = await this.call(
                `https://gitlab.com/api/v4/projects/${encodeURIComponent(d.project)}/issues`,
                json(credential.token, {
                    title: p.title,
                    description: `${p.text}\n\n${marker}`,
                    labels: d.labels.join(","),
                    ...(d.assignee ? { assignee_ids: [d.assignee] } : {}),
                }),
                true
            );
            return this.result(r.web_url, r.iid);
        }
        if (d.provider === "linear") {
            const init = json(credential.token, {
                query: "mutation Create($input: IssueCreateInput!) { issueCreate(input:$input) { success issue { id identifier url } } }",
                variables: {
                    input: {
                        id: operation,
                        teamId: d.team,
                        title: p.title,
                        description: p.text,
                        labelIds: d.labels,
                        ...(d.assignee ? { assigneeId: d.assignee } : {}),
                    },
                },
            });
            init.headers = {
                ...init.headers,
                Authorization: credential.oauth ? `Bearer ${credential.token}` : credential.token,
            };
            const r = await this.call("https://api.linear.app/graphql", init, true);
            const data = r.data as
                | {
                      issueCreate?: {
                          success?: boolean;
                          issue?: { url: string; identifier: string };
                      };
                  }
                | undefined;
            if (r.errors || !data?.issueCreate?.success)
                throw new ProviderError(
                    "review",
                    "Linear did not confirm issue creation. Check the destination."
                );
            return this.result(data.issueCreate.issue?.url, data.issueCreate.issue?.identifier);
        }
        if (d.provider === "slack") {
            const r = await this.call(
                "https://slack.com/api/chat.postMessage",
                json(credential.token, {
                    channel: d.channel,
                    text: `${p.title}\n${p.text}`,
                    mrkdwn: false,
                    unfurl_links: false,
                    unfurl_media: false,
                    client_msg_id: operation,
                }),
                true
            );
            if (r.ok !== true)
                throw new ProviderError(
                    r.error === "ratelimited" ? "retry" : "failed",
                    "Slack did not accept the message. Check the channel and connection permissions."
                );
            return { reference: String(r.ts ?? operation) };
        }
        if (d.provider === "teams") {
            await this.call(
                credential.token,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "message",
                        attachments: [
                            {
                                contentType: "application/vnd.microsoft.card.adaptive",
                                contentUrl: null,
                                content: {
                                    type: "AdaptiveCard",
                                    version: "1.4",
                                    body: [
                                        {
                                            type: "TextBlock",
                                            text: p.title,
                                            weight: "Bolder",
                                            wrap: true,
                                        },
                                        { type: "TextBlock", text: p.text, wrap: true },
                                    ],
                                    actions: [
                                        {
                                            type: "Action.OpenUrl",
                                            title: "View in Notato",
                                            url: p.url,
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                },
                true
            );
            return { reference: operation };
        }
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const body = JSON.stringify({
            id: operation,
            type: "notato.feedback",
            title: p.title,
            text: p.text,
            url: p.url,
            noteIds: p.noteIds,
        });
        const signature = createHmac("sha256", credential.refreshToken ?? credential.token)
            .update(`${timestamp}.${body}`)
            .digest("hex");
        await this.call(
            credential.token,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Notato-Id": operation,
                    "X-Notato-Timestamp": timestamp,
                    "X-Notato-Signature": `sha256=${signature}`,
                },
                body,
            },
            true
        );
        return { reference: operation };
    }
    private result(url: unknown, reference: unknown): Result {
        if (typeof url !== "string")
            throw new ProviderError(
                "review",
                "The provider did not return an issue link. Check the destination."
            );
        const checked = outboundUrl(url);
        if (!["github.com", "dev.azure.com", "gitlab.com", "linear.app"].includes(checked.hostname))
            throw new ProviderError("review", "The provider returned an unexpected issue link.");
        return { url: checked.href, reference: String(reference).slice(0, 100) };
    }
}
