import Foundation
@testable import Notato

/// The network a recorded request is made again on, in place of a server: `/stream` answers in pieces, `/old`
/// redirects to `/new`, and `/private` asks who is asking.
final class RelayNetwork: URLProtocol, URLAuthenticationChallengeSender, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    /// Answers in pieces a moment apart, from this thread's run loop as a server's bytes would come.
    private func answer(_ status: Int, _ body: [String], headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let rest = Pieces(body)
        let mode = RunLoop.current.currentMode ?? .default
        let timer = Timer(timeInterval: 0.02, repeats: true) { [self] timer in
            if let piece = rest.next() {
                client?.urlProtocol(self, didLoad: Data(piece.utf8))
            } else {
                timer.invalidate()
                client?.urlProtocolDidFinishLoading(self)
            }
        }
        RunLoop.current.add(timer, forMode: mode)
    }

    override func startLoading() {
        switch request.url!.path {
        case "/stream": answer(200, ["one ", "two ", "three"])
        case "/old":
            // As the system's own loading does: the redirect, then (for a session that does not follow it) its response.
            let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": "/new"])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: "http://app.test/new")!), redirectResponse: response)
            answer(302, ["moved"], headers: ["Location": "/new"])
        case "/new": answer(200, ["arrived"])
        case "/private":
            let space = URLProtectionSpace(host: "app.test", port: 80, protocol: "http", realm: "shop", authenticationMethod: NSURLAuthenticationMethodHTTPBasic)
            client?.urlProtocol(self, didReceive: URLAuthenticationChallenge(protectionSpace: space, proposedCredential: nil, previousFailureCount: 0,
                                                                             failureResponse: nil, error: nil, sender: self))
        default: answer(404, [])
        }
    }

    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) { answer(200, ["welcome \(credential.user ?? "?")"]) }
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) { answer(401, ["who?"]) }
    func cancel(_ challenge: URLAuthenticationChallenge) { client?.urlProtocol(self, didFailWithError: URLError(.userCancelledAuthentication)) }
    func performDefaultHandling(for challenge: URLAuthenticationChallenge) { answer(401, ["who?"]) }
    func rejectProtectionSpaceAndContinue(with challenge: URLAuthenticationChallenge) { answer(401, ["who?"]) }
}

/// What is left of an answer, handed out a piece at a time.
final class Pieces: @unchecked Sendable {
    private var rest: [String]
    init(_ pieces: [String]) { rest = pieces }
    func next() -> String? { rest.isEmpty ? nil : rest.removeFirst() }
}

/// The app's session's delegate, keeping what it is told.
final class AppSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var _pieces: [Data] = []
    private var _redirects: [String] = []
    private var _challenges: [String] = []
    private var finished: CheckedContinuation<(URLResponse?, Error?), Never>?
    private var response: URLResponse?
    let follow: Bool

    init(follow: Bool = true) { self.follow = follow }

    var pieces: [Data] { lock.withLock { _pieces } }
    var redirects: [String] { lock.withLock { _redirects } }
    var challenges: [String] { lock.withLock { _challenges } }

    func load(_ path: String, through protocols: [AnyClass] = [NotatoNetworkRecorder.self]) async -> (response: HTTPURLResponse?, body: String, error: Error?) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = protocols
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (response, error) = await withCheckedContinuation { continuation in
            lock.withLock { finished = continuation }
            session.dataTask(with: URL(string: "http://app.test\(path)?secret=1")!).resume()
        }
        return (response as? HTTPURLResponse, String(decoding: pieces.reduce(Data(), +), as: UTF8.self), error)
    }

    /// Starts a load and leaves it going (one that never ends, say).
    func start(_ url: URL) -> (URLSession, URLSessionDataTask) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NotatoNetworkRecorder.self]
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: url)
        task.resume()
        return (session, task)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        lock.withLock { self.response = response }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock { _pieces.append(data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        lock.withLock { _redirects.append(request.url?.path ?? "") }
        completionHandler(follow ? request : nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        lock.withLock { _challenges.append(challenge.protectionSpace.realm ?? "") }
        completionHandler(.useCredential, URLCredential(user: "dom", password: "pw", persistence: .none))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (continuation, response) = lock.withLock {
            defer { finished = nil }
            return (finished, self.response ?? task.response)
        }
        continuation?.resume(returning: (response, error))
    }
}
