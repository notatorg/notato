# Capture permissions and delivery

The browser (including React and Angular), Swift, Android, MAUI, React Native and Flutter SDKs use the same contract.

## Capture-only credentials

A capture-only app token can submit new feedback to its own project, individually or as a test bundle at
`POST /projects/:id/bundles`. Both forms use the normal validation, screenshot policy, upload limits and ingestion
hooks. A bundle creates human feedback with fresh lifecycle state. It cannot restore replies, agent attribution,
statuses, variants or integration links. Referenced screenshots must be included in the submission.

These tokens cannot list, read, export, change or delete saved feedback, download screenshots, use event streams
or authenticate MCP. They can read the minimal capture policy and check their connection.

## Retries and conflicts

SDKs keep the same annotation id and content while retrying a submission. The server stores a private receipt
atomically with each accepted capture. It binds the note to the credential identity, project, deployment scope,
submitted content and image bytes; it stores no credential secret. JSON key order and zip packaging details do not
change the receipt. Lifecycle fields discarded by capture do not become an update on retry.

The first accepted capture returns `201`. An identical retry from that same credential returns `200`, even if the
response to the original request was lost. The acknowledgement echoes the submitted note for existing SDK decoders;
it never returns the stored report, subsequent replies, edits, sequence number or receipt metadata. A bundle retry
reports counts only after its existing notes have matched that credential's receipts. Repackaging the same notes
under a different bundle id is safe.

A different payload, image, project or credential is a `409` conflict. SDKs retain the local note and its screenshots,
show the refusal and continue with the other queued notes. They never assume a generic `409` means delivery, and
never change an id automatically to bypass a conflict. Older servers without receipts also leave a conflict visible;
check the board to resolve uncertain delivery. Existing notes without receipts cannot be claimed by a capture token.

SQLite schema 7 stores receipts beside the annotation JSON, outside exports and normal reads. Extensions can accept
the optional third `Store.insertAnnotation` argument and implement `getCaptureReceipt`, storing them atomically.
Without receipt support, duplicate capture ids safely remain conflicts. An application's ordinary full-access
idempotent ingestion and offline bundle imports keep their existing behaviour.

## Screenshot policy

With any server configured, including test mode, capture starts without permission to take screenshots. The SDK
requires an explicit `screenshots: true` response from the project's `/config` endpoint before capturing pixels.
Unavailable, malformed or older responses that have not granted that permission leave capture text-only. The note
and pin still work. The browser's settings explain when server permission is unavailable.

Local-only/offline capture with no server configured does not need this permission and continues taking screenshots
according to the SDK's local settings. A normal `npx notato` developer server supplies the policy without an account
or token. A successful policy response with screenshots disabled prevents capture, and the server also discards any
screenshots submitted against its policy. A server change starts a fresh policy negotiation.
