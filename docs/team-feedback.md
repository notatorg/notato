# Checkout contexts and review ownership

A project is one app or repository. Give each developer/worktree its own checkout in **Team and checkouts**.
Connecting the first checkout enables team queues for the project: older project-wide agents stop receiving its
work. Existing feedback stays visible in the shared inbox; deliberately assign it instead of guessing its owner.
The ordinary account-free local loop continues to work on projects that have no checkout contexts.

Create a checkout, then **Set up app and agent** to generate two credentials. The app key can capture, read and reply to feedback only in that checkout; it cannot drive MCP. It goes in the SDK's
`token` option; its `server` is the same origin as the board. Keep the agent key in `NOTATO_AGENT_TOKEN` and use
this MCP command locally:

```sh
npx notato dev --server https://your-notato-server.example --project your-project
```

This connects the local agent to the selected server without starting a second server or silently falling back
when it is unavailable. Loopback HTTP is supported for local contexts. Local servers must remain running while
an agent connects remotely to them. The same public capture/MCP contracts are available to managed deployments.
Secrets belong in ignored environment files or an agent's secret environment, never in Git. Keys expire after
90 days by default and count toward a deployment's existing key allowance.

Capture is bound to the context in its credential. A client-supplied reviewer name, branch, URL or work ID cannot
select another queue. Human board access stays at the project/workspace boundary: checkout queues do not hide
feedback from teammates. An unassigned shared review reaches no checkout agent until a person assigns it. Related
review targets move together; one developer may have several worktrees and therefore several checkout connections.

Agents call `notato_claim` before editing/acknowledging/replying. A persisted atomic claim reserves the entire review.
They renew it with `notato_heartbeat` at least every two minutes, and stop editing before `notato_release`. Only one
session can hold a review. Five-minute lease expiry requires explicit human recovery because the old agent may
still be editing files. Assignment/recovery changes the claim version; late status updates and replies fail even
if an agent still has the old note cached. Record the actual branch and full commit with `notato_record_resolution`.
That records a fix on that branch; it does not assert verification or merge.

Board members can take shared work for their own checkout and release their own assignments. Deployment managers
can reassign across developers. Archiving a checkout stops its credentials and existing agent sessions; create a
new checkout to reconnect. Offline bundle imports are refused for context-bound capture keys; use live capture
for a checkout review. Unscoped tester bundles remain shared and can be assigned on the board.

SQLite schema 8 adds private context/work records and token bindings. Existing feedback is retained. Keep a
pre-upgrade backup with the matching binary before upgrading a self-managed service. Older builds reject the newer
schema; rollback requires that saved database. Contexts are not extra projects. Coordination handles Notato work
ownership; ordinary Git review and merging still handle conflicts between source changes.
