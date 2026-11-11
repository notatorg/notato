using Microsoft.Maui.Controls;
using Notato.Maui.Model;
using Notato.Maui.Overlay;
using System.Text.Json;

namespace Notato.Maui.Tests;

public class ReplyImagesTests
{
    private const string Plain = """{"id":"r1","author":{"kind":"human","name":"Dom"},"body":"Thanks!","createdAt":"2026-11-10T09:00:00.000Z"}""";

    private const string WithImages = """
        {"id":"r2","author":{"kind":"agent","name":"Claude"},"body":"Like these?","createdAt":"2026-11-10T09:01:00.000Z",
         "images":[{"id":"img_1","mime":"image/png","w":640,"h":480,"path":"assets/img_1.png","name":"before.png"},
                   {"id":"img_2","mime":"image/webp","w":320,"h":240,"name":"after.webp"}]}
        """;

    [Fact]
    public void A_reply_reads_with_or_without_images()
    {
        Reply plain = JsonSerializer.Deserialize(Plain, NotatoJsonContext.Default.Reply)!;
        Assert.Null(plain.Images);
        Assert.DoesNotContain("images", JsonSerializer.Serialize(plain, NotatoJsonContext.Default.Reply));

        Reply reply = JsonSerializer.Deserialize(WithImages, NotatoJsonContext.Default.Reply)!;
        Assert.Equal(2, reply.Images!.Count);
        Assert.Equal(new ReferenceImage { Id = "img_1", Mime = "image/png", W = 640, H = 480, Path = "assets/img_1.png", Name = "before.png" }, reply.Images[0]);
        Assert.Null(reply.Images[1].Path);
        Assert.Equal("after.webp", reply.Images[1].Name);
    }

    [Fact]
    public void The_thread_says_how_many_images_came_with_a_reply()
    {
        Reply plain = JsonSerializer.Deserialize(Plain, NotatoJsonContext.Default.Reply)!;
        Reply two = JsonSerializer.Deserialize(WithImages, NotatoJsonContext.Default.Reply)!;
        Reply one = two with { Images = [two.Images![0]] };

        Assert.Null(PinCard.ImagesLine(plain));
        Assert.Null(PinCard.ImagesLine(plain with { Images = [] }));
        Assert.Equal("1 image attached", PinCard.ImagesLine(one));
        Assert.Equal("2 images attached", PinCard.ImagesLine(two));

        // Without images the entry is the one line it always was; with them, the count goes under the words.
        Assert.IsType<Label>(PinCard.ReplyView(plain).Content);
        VerticalStackLayout stack = Assert.IsType<VerticalStackLayout>(PinCard.ReplyView(two).Content);
        Label line = Assert.IsType<Label>(stack.Children[1]);
        Assert.Equal("2 images attached", line.Text);
    }
}
