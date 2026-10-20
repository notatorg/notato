# Reviews

Open a project and choose **Reviews**. Testing sessions and pull-request reviews appear together, newest first,
with a label identifying each type. They group feedback for a particular testing pass or change; the project's
**Inbox** remains the place to browse individual annotations.

## Testing sessions

Choose **New review → Testing session** to collect related feedback, describe its focus, and optionally record
a branch and environment. A new manual session starts personal. Choose shared visibility when collaborators
should read the session, and add existing feedback that you can access. Test-mode SDK captures also create
sessions automatically; those testing passes start shared.

Open a session to discuss the work, close or reopen the pass, and use **Copy agent handoff** to give an agent its
focus, conversation and accessible notes. Closing a session stops new captures into that pass. Each annotation
keeps its own status, conversation and visibility, even when it belongs to more than one group.

The lightweight SQLite developer server supports testing sessions without GitHub or a provider account.
See [personal feedback and teams](team-feedback.md) for the visibility and MCP handoff rules.

## Pull-request reviews

The full server also offers **New review → Pull request** to review a GitHub PR's running app preview. Configure
GitHub under the selected workspace's **Integrations**, then return to the project's Reviews page. Choose the
connection, paste the GitHub.com PR URL and optionally provide its running preview URL. The current project is
already selected. Workspace members use repositories an owner/admin has configured for that project through
a saved GitHub action; an owner/admin can also start the review directly. Project guests do not get PR controls.

Notato records the reviewed head commit. It does not host or deploy the preview. **Set up preview capture**
provides a capture-only SDK key tied to the review; configure the preview with that key, server and project ID.
An optional assignment to a developer's **dev setup** is managed through **Assignments** and the PR review.

**Refresh PR status** (or **Check GitHub now** when webhooks are configured) checks the PR's state and latest
commit while preserving the reviewed commit. A newer commit needs its own review round. Starting the same
project/repository/PR/commit again opens the existing round.

**Preview GitHub summary** shows what will be sent. **Confirm and publish review** is a separate action that posts
a comment review to GitHub at the reviewed commit. Connecting a PR, capturing feedback or assigning it does not
publish a summary. Publishing does not approve, request changes, merge or close the PR.

## Filters and privacy

On the full server, **All reviews**, **Testing sessions** and **Pull requests** filter the list by type.
The visibility selector offers **All accessible**, **Created by me** and **Shared with project**. Created by me
includes the current person's own shared reviews as well as personal sessions; it differs from the Inbox's
**Mine** scope, which means personal annotations only.

Only reviews in the selected project are listed, and project access is checked by the server. A personal session
is visible only to its creator. Sharing a session does not share its personal annotations, and reading a shared
annotation does not grant access to a private session that contains it. PR review groups are shared with the
project; annotation-level privacy still applies.

## Navigation and saved links

The canonical list address is `#/p/<project>/reviews`. Testing-session details use
`#/p/<project>/reviews/session/<id>`, and PR details use `#/p/<project>/reviews/pull-request/<id>`.
Existing project `/sessions` links remain supported. Saved workspace-wide `#/x/pr-reviews/<id>` links open
the same authorized review in its project; the old list link opens the remembered accessible project.
The API paths and MCP review-session tool names are unchanged.

Integrations belongs to a workspace; Reviews and Assignments belong to a project. **Workspace settings** manages
workspace people, credentials and policies. The account menu holds **Account**, **Appearance** and **Sign out**.
**Administration** is shown only for explicit global administrator permissions. These scopes are the same for
self-hosted and managed deployments; see [navigation and permissions](../deploy/self-hosted/README.md#navigation-and-permissions).
