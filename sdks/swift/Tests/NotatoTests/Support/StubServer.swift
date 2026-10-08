import Foundation
@testable import Notato

/// Answers a test's requests in place of a server.
final class StubServer: URLProtocol, @unchecked Sendable {
    /// A request as the server got it.
    struct Seen: Sendable {
        var method: String
        var url: URL
        var body: Data
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var answer: @Sendable (URLRequest) -> (Int, Data) = { _ in (404, Data()) }
    nonisolated(unsafe) private static var seen: [Seen] = []

    static func client(_ answer: @escaping @Sendable (URLRequest) -> (Int, Data)) -> NotatoClient {
        lock.lock()
        self.answer = answer
        seen = []
        lock.unlock()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubServer.self]
        return NotatoClient(base: URL(string: "http://stub.test")!, token: nil, session: URLSession(configuration: configuration))
    }

    static var requests: [URL] { received.map(\.url) }

    static var received: [Seen] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    /// A body set on a request reaches a URLProtocol as a stream.
    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.lock.lock()
        Self.seen.append(Seen(method: request.httpMethod ?? "GET", url: request.url!, body: Self.body(of: request)))
        let answer = Self.answer
        Self.lock.unlock()
        let (status, body) = answer(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
