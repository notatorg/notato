# Personal feedback, teams and review sessions

One project represents the app or repository. Everyone uses its project ID and SDK configuration, with their own App and Agent credentials kept in their local environment. There are no connection profiles or checkout-specific launch commands.

## Dev and Test

**Dev defaults to personal feedback.** It syncs to the configured server, where only its authenticated creator can read it. The creator’s agent starts in Mine. Choose **Share with project** in the composer or board when a teammate should take part. Adding members, moving a project to a team and sharing a session never change an annotation’s visibility automatically.

**Test defaults to shared feedback.** With a server configured, notes arrive live in a persistent review session from the start of the testing run. Without a server, Test keeps notes on the device and can export a zip. Importing that zip preserves grouping. A tester can name the session, set the focus, branch and environment, discuss the group, and close the session when the pass is finished. A closed session refuses new captures; start a new run or reopen it.

All SDK composers offer **Share with project**. Its initial state follows Dev/Test. **People only** remains a separate switch: agents cannot read the annotation or conversation while it is on, even if the annotation is shared.

| Persona | Workflow |
| --- | --- |
| Solo developer | Use the local server with no account, or Cloud with personal credentials. Capture in Dev; the agent’s Mine queue contains only that person’s personal feedback. |
| Developer in a team | Use the same project ID as colleagues, authenticate independently, and share particular notes when ready. Personal exploration stays private. |
| Tester | Use Test for a shared testing pass. The live session groups its feedback immediately; open it under the project's Reviews page to name it and describe the focus. Offline packaging remains available. |
| Developer picking up QA results | Open a shared session or make a manual review group, then use Copy agent handoff. The agent reads that session’s focus, conversation and accessible notes. |
| Team lead collecting related work | Add accessible feedback from several testing runs to a review session. This creates links; original testing sessions and note ownership stay intact. |

## Visibility and groups

The board offers **All accessible**, **Mine** and **Shared**. Mine means personal annotations belonging to the current authenticated creator. Shared means feedback visible to project members. All accessible combines those two; it never includes another person’s private feedback.

Review sessions have independent personal/shared visibility and their own conversations. A private session can contain a shared annotation. Someone who can read that annotation still cannot read the private session, its description, conversation or other annotations. Sharing a session exposes its own description and conversation, and only annotations the viewer is separately allowed to read. Raw membership lists never disclose the IDs of inaccessible personal notes.

Use **Reviews → New review → Testing session** to create a manual group, add existing accessible feedback, and describe the task. On the lightweight server, New review opens the session form directly. Feedback can appear in its original testing run and in additional manual groups. Each annotation retains its own status and thread. The existing grouped-review composer is also useful when several selected targets should receive one consistent UI change.

The full server's project Reviews page also lists GitHub pull-request reviews, with type labels and filters. GitHub configuration stays under the workspace's Integrations page. See the [Reviews guide](reviews.md) for both workflows, visibility filters and saved links.

Withdrawing a shared note removes it from teammates’ live boards. Sharing an older personal note deliberately wakes the shared agent queue even if the agent already passed that note’s original sequence number. Visibility changes are recorded in the note’s thread.

## Agent handoff

Ordinary agent access starts in Mine. Identity comes from authentication, not a user ID supplied by an MCP caller. Every direct read, mutation, screenshot, export and event applies the same privacy rules.

```ts
notato_list_open({ projectId: "proj_checkout" }); // Mine
notato_list_open({ projectId: "proj_checkout", scope: "shared" });
notato_list_open({ projectId: "proj_checkout", scope: "all" });
```

For a review handoff, use **Copy agent handoff**, or select a specific session:

```ts
notato_list_review_sessions({ projectId: "proj_checkout", scope: "shared" });
notato_get_review_session({ id: "review_abc" });
notato_list_open({ sessionId: "review_abc" });
notato_watch({ sessionId: "review_abc" });
notato_reply_review_session({ id: "review_abc", body: "I’ll fix keyboard navigation first." });
```

Selecting a session explicitly includes its accessible shared feedback and keeps subsequent work within that group. It never gives the agent access to someone else’s personal notes. Calling the ordinary list/watch again without a session returns to Mine unless another scope is explicitly supplied.

In the board, a checkout or worktree connection is called a **dev setup** (the **Assignments** page). Checkout assignment is optional. It reserves work explicitly assigned to a checkout; merely configuring a checkout no longer disables the ordinary developer loop for the rest of the project. Personal feedback can only be assigned to its creator’s checkout.

## Project ownership and membership

New projects belong to their creator. Add existing collaborators in **Project settings → Project members**, or use Cloud’s email-bound project invitation links. A project invitation grants that project’s shared feedback, rather than unrelated workspace projects. Verified invitees sign in themselves and accept the link; the application does not automatically send invitation emails.

Project owners/admins manage project members. Workspace owners/admins can manage projects in their workspace, while annotation privacy still applies to them. Project ownership can be handed to another current project member without recreating the project.

To move from an individual workspace to a team, choose **Move to a workspace you manage** in Cloud project settings. The project ID, feedback creators, visibility, sessions and conversations are retained. The destination must have capacity, and the caller must manage both the source project and destination workspace. Old App/Agent credentials are revoked; plugin actions are archived and automatic workflows stop, so credentials for the old workspace cannot keep exporting feedback. Running or uncertain plugin operations must be reconciled before moving. Reconnect the project from the destination workspace.

Existing projects without explicit membership records retain their previous workspace-wide access. A project-scoped invitation does not grant an invitee access to those legacy workspace projects. Removing a collaborator revokes their project access; their personal notes remain personal. Workspace offboarding also revokes personal credentials and sessions and removes project memberships. Any project they individually owned in that team is retained under the workspace’s ownership, without sharing their personal feedback.

## Self-hosted teams and local-only feedback

The account-free loopback server remains a single-person local workflow. For the full self-hosted server, the administrator uses **Administration → Invite an account**, then collaborators join the relevant workspace or projects. Members sign in independently and create their own App/Agent credentials. They manage their profile, password and devices through **their account menu → Account**. Password changes offer signing out other devices. See [self-hosting](../deploy/self-hosted/README.md) for invitation and SMTP setup.

The lightweight shared server's local-account mode remains available separately: its administrator creates member accounts in **Settings → Server accounts**. Password changes in that mode revoke existing browser sessions.

For feedback that must stay on this computer, choose **Keep feedback local to this computer** in the browser toolbar’s settings. The toolbar switches to the loopback development server, drops Cloud credentials, disables external delivery sinks and marks new notes local-only. The local MCP server reads that feedback. Choosing the configured server again affects future capture; earlier local-only feedback stays on the local server. The choice lasts for the browser tab’s session.

Applications can also set `localOnly: true` and an optional loopback `localServer` in the browser/React/Angular SDK. A shared or Cloud server refuses local-only annotations and bundles, including manually uploaded exports. Native apps can continue using a local development server or device-only offline storage; their composers now expose the same personal/shared choice.

## Compatibility and integrations

Deploy the updated server alongside these SDKs before relying on personal visibility. Older servers do not enforce this privacy model. Older annotations without visibility remain Shared because their creator cannot be established reliably. Older project/service credentials intentionally act as a shared identity and should not be used for per-developer privacy. New project-creation credentials belong to the creator; teammates issue personal credentials from their own account.

Project-level webhooks and automatic Cloud workflows receive Shared feedback only. A creator can explicitly send their own private note to a plugin using a manual action. Turning a note back to personal prevents pending automatic deliveries from disclosing it; previously completed external deliveries cannot be recalled.

## Developing the server and board

The full MIT server and board live in this public repository's `services/` directory. Shared board components and the lightweight SQLite server remain under `packages/`. Run package and Git commands here; new product work does not require the private legacy deployment repository or its pinned `core/` checkout. See [server architecture](../services/README.md).
