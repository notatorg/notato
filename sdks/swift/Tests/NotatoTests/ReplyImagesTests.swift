import Foundation
import Testing
@testable import Notato

@Suite("Images on replies")
struct ReplyImagesTests {
    @Test func aReplyReadsWithAndWithoutImages() throws {
        let plain = #"{"id":"r1","author":{"kind":"human","name":"Dom"},"body":"Like this","createdAt":"2026-11-10T08:00:00.000Z"}"#
        #expect(try NotatoJSON.decoder.decode(Reply.self, from: Data(plain.utf8)).images == nil)

        let shot = #"{"id":"\#(String(repeating: "c", count: 64))","mime":"image/webp","w":800,"h":600,"name":"mock.webp"}"#
        let json = #"{"id":"r2","author":{"kind":"human","name":"Dom"},"body":"Like this","createdAt":"2026-11-10T08:00:00.000Z","images":[\#(shot),{"id":"d","mime":"image/png","w":1,"h":2,"path":"refs/1.png","name":"b.png"}]}"#
        let reply = try NotatoJSON.decoder.decode(Reply.self, from: Data(json.utf8))
        let images = try #require(reply.images)
        #expect(images.count == 2)
        #expect(images[0] == ImageAttachment(id: String(repeating: "c", count: 64), mime: "image/webp", w: 800, h: 600, path: nil, name: "mock.webp"))
        #expect(images[1].path == "refs/1.png")
        #expect(try NotatoJSON.decoder.decode(Reply.self, from: NotatoJSON.encoder.encode(reply)) == reply)
    }

    @Test func theThreadCountsThem() {
        #expect(CardCopy.imagesAttached(1) == "1 image attached")
        #expect(CardCopy.imagesAttached(3) == "3 images attached")
    }
}
