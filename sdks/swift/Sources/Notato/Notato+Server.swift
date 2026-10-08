import Foundation

// The connection to the server: its event stream, read for as long as Notato is on, and what each event does.
extension Notato {
    /// The longest wait between attempts to connect, in seconds. The wait doubles from one second up to it.
    private static let maxReconnectDelay = 10

    /// (Re)opens the connection to the server, or says why there is none. Called on start, on a settings change and on
    /// Retry; the previous connection is closed first.
    func restartSync() {
        syncTask?.cancel()
        syncTask = nil
        guard isEnabled, let configuration else { return }
        client = server.map { client(for: $0) }
        guard hasServer, let client else {
            connection = .local
            connectionDetail = mode == .test ? nil : "No server is set: notes stay on this device."
            return
        }
        let project = configuration.project
        let agent = mode == .agent
        syncTask = Task { [weak self] in
            var delay = 1
            while !Task.isCancelled {
                self?.connection = .connecting
                do {
                    for try await event in client.events(project: project, agent: agent) {
                        await self?.handle(event, client: client)
                        delay = 1
                    }
                    if Task.isCancelled { return }
                    self?.setConnection(.offline, "The server closed the connection.")
                } catch let error as NotatoServerError where error.permanent {
                    // Asking again straight away would be refused the same way.
                    self?.setConnection(.refused, error.message)
                    delay = Self.maxReconnectDelay
                } catch {
                    if Task.isCancelled { return }
                    self?.setConnection(.offline, (error as? NotatoServerError)?.message ?? error.localizedDescription)
                }
                try? await Task.sleep(for: .seconds(delay))
                delay = min(Self.maxReconnectDelay, delay * 2)
            }
        }
    }

    /// A client of `server`, with the project token when the server may have it (`token(for:configuration:)`).
    func client(for server: URL) -> NotatoClient {
        NotatoClient(base: server, token: configuration.flatMap { Self.token(for: server, configuration: $0) })
    }

    /// The project token, if `server` may have it: only the server it was configured for does (the same scheme, host
    /// and port). A server typed into Settings gets none, so the token never goes anywhere it was not set up to go,
    /// over plain http least of all.
    static func token(for server: URL, configuration: NotatoConfiguration) -> String? {
        guard let token = configuration.token, !token.isEmpty, let configured = configuration.resolvedServer,
              let origin = origin(of: server), origin == Self.origin(of: configured) else { return nil }
        return token
    }

    /// Scheme, host and port, with the scheme's own port when none is written.
    private static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : -1)
        return "\(scheme)://\(host):\(port)"
    }

    /// Tries the server again now, instead of waiting out the backoff between attempts (the menu's Retry).
    func retryConnection() {
        guard isEnabled, hasServer else { return }
        restartSync()
    }

    private func setConnection(_ next: NotatoConnection, _ detail: String?) {
        guard isEnabled else { return }
        connection = next
        connectionDetail = detail
    }

    /// One event from the server: `hello` on each connection, then each change to the project's notes, and (in agent
    /// mode) an agent's request to annotate something.
    func handle(_ event: ServerSentEvent, client: NotatoClient) async {
        switch event.event {
        case "hello":
            setConnection(.connected, nil)
            serverScreenshots = (try? await client.config())?.screenshots ?? serverScreenshots
            // The notes made while away go first, so the list read next has them.
            let held = await flush()
            await reload(client)
            // Connected, yet a note was not taken (an unknown project, a token that may not write): say why.
            if let held, held.status != 0 {
                platform?.toast("Notes not sent: \(held.message)")
            }
        case "created", "updated", "replied":
            if let annotation = Self.payload(ServerEventData.self, of: event)?.annotation { upsert(annotation) }
        case "deleted":
            if let id = Self.payload(ServerEventData.self, of: event)?.id { deletedOnServer(id) }
        case "annotate-request":
            if let request = Self.payload(AnnotateRequest.self, of: event) {
                Task { await self.answerRelay(request, client: client) }
            }
        default:
            // An event from a newer server that this SDK does not know.
            break
        }
    }

    /// An event's JSON, or nil (logged) when it cannot be read.
    private static func payload<T: Decodable>(_ type: T.Type, of event: ServerSentEvent) -> T? {
        do {
            return try NotatoJSON.decoder.decode(type, from: Data(event.data.utf8))
        } catch {
            log.warning("Notato could not read a \(event.event, privacy: .public) event: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Reads every note of the project, a page at a time, then forgets those the server no longer has. Nothing is
    /// forgotten unless every page came: a list cut short would look like deletions. The list is a summary (no
    /// context, no steps), which is all the overlay shows and a small part of a note's size.
    private func reload(_ client: NotatoClient) async {
        guard let project = configuration?.project else { return }
        let known = Set(records.lazy.filter { !$0.pending }.map(\.id))
        let items: [StoredAnnotation]
        do {
            items = try await client.list(project: project, summary: true)
        } catch is CancellationError {
            return
        } catch {
            log.error("Notato could not read the project's notes from the server: \(error.localizedDescription, privacy: .public)")
            return
        }
        merge(items.map(\.annotation), summary: true)
        let forgotten = Self.forgotten(known: known, listed: items, now: records)
        if !forgotten.isEmpty { forget { forgotten.contains($0.id) } }
    }

    /// Agent mode: an agent asked, through `notato_annotate`, for something in this app to be annotated.
    private func answerRelay(_ request: AnnotateRequest, client: NotatoClient) async {
        let result: RelayResult
        do {
            let annotation = try await annotate(request.args.target, comment: request.args.comment, options: AnnotateOptions(
                severity: request.args.severity, intent: request.args.intent, agentName: request.args.author ?? "agent", steps: request.args.steps))
            if let record = record(annotation.id), record.pending, let notice = record.notice {
                // Made, but the server answered and did not take it (a project it does not know, say): reporting it
                // filed would send the agent looking for a note the server does not have.
                let reason = notice.hasSuffix(".") ? notice : notice + "."
                result = RelayResult(ok: false, annotationId: nil, error: "The note was made on the device but the server did not take it: \(reason) It is sent again on the next connection.")
            } else {
                result = RelayResult(ok: true, annotationId: annotation.id, error: nil)
            }
        } catch {
            result = RelayResult(ok: false, annotationId: nil, error: error.localizedDescription)
        }
        do {
            try await client.relayResult(requestId: request.requestId, result)
        } catch {
            log.warning("Notato could not report an annotate result: \(error.localizedDescription, privacy: .public)")
        }
    }
}
