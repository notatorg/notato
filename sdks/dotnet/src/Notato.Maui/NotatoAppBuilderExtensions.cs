using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Maui;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Handlers;
using Microsoft.Maui.Hosting;
using Notato.Maui.Inspection;
using Notato.Maui.Runtime;

namespace Notato.Maui;

/// <summary>Adds Notato to a MAUI app in <c>MauiProgram</c>.</summary>
public static class NotatoAppBuilderExtensions
{
    private static bool windowsHooked;

    /// <summary>
    /// Adds Notato, bound from the <c>Notato</c> section of <c>builder.Configuration</c> when there is one, then
    /// adjusted by <paramref name="configure"/>.
    /// <code>
    /// builder.UseMauiApp&lt;App&gt;()
    ///        .UseNotato(options =&gt; options.Project = "checkout-app");
    /// </code>
    /// </summary>
    public static MauiAppBuilder UseNotato(this MauiAppBuilder builder, Action<NotatoOptions>? configure = null) =>
        builder.UseNotato(builder.Configuration.GetSection(NotatoOptions.SectionName), configure);

    /// <summary>Adds Notato, bound from a configuration section (for example <c>builder.Configuration.GetSection("Feedback")</c>).</summary>
    public static MauiAppBuilder UseNotato(this MauiAppBuilder builder, IConfiguration section, Action<NotatoOptions>? configure = null)
    {
        builder.Services.AddNotato(section, configure);

        // Options are bound lazily, but these two must happen before the first page exists.
        NotatoOptions early = new();
        section.Bind(early);
        configure?.Invoke(early);
        if (early.XamlSourceInfo)
        {
            SourceLocator.EnableXamlSourceInfo();
        }

        if (early.CaptureLogs)
        {
            builder.Logging.AddProvider(LogRecorder.Shared);
        }

        if (!windowsHooked)
        {
            windowsHooked = true;
            // Each window gets the overlay once its content is set; the controller decides whether Notato is on.
            WindowHandler.Mapper.AppendToMapping(nameof(IWindow.Content), (handler, window) =>
            {
                if (window is Window mauiWindow && handler.MauiContext?.Services.GetService<NotatoController>() is { } controller)
                {
                    controller.OnWindowContent(mauiWindow);
                }
            });
#if ANDROID
            // Android draws an underline under text fields; Notato's sit in boxes of their own. The app's fields are untouched.
            EditorHandler.Mapper.AppendToMapping("NotatoField", (handler, view) =>
            {
                if (view is Overlay.NotatoEditor)
                {
                    handler.PlatformView.Background = null;
                }
            });
            EntryHandler.Mapper.AppendToMapping("NotatoField", (handler, view) =>
            {
                if (view is Overlay.NotatoEntry)
                {
                    handler.PlatformView.Background = null;
                }
            });
#elif IOS || MACCATALYST
            // iOS draws a rounded border round a text field; Notato's sit in boxes of their own. The app's fields are untouched.
            EntryHandler.Mapper.AppendToMapping("NotatoField", (handler, view) =>
            {
                if (view is Overlay.NotatoEntry)
                {
                    handler.PlatformView.BorderStyle = UIKit.UITextBorderStyle.None;
                }
            });
#endif
        }
        return builder;
    }

    /// <summary>Registers Notato's options and services. <c>UseNotato</c> calls this; use it directly only to register without the overlay hook.</summary>
    public static IServiceCollection AddNotato(this IServiceCollection services, IConfiguration? section = null, Action<NotatoOptions>? configure = null)
    {
        OptionsBuilder<NotatoOptions> options = services.AddOptions<NotatoOptions>();
        if (section is not null)
        {
            options.Bind(section);
        }

        if (configure is not null)
        {
            options.Configure(configure);
        }

        services.TryAddSingleton<NotatoController>();
        services.TryAddSingleton<INotato>(sp => sp.GetRequiredService<NotatoController>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IMauiInitializeService, NotatoInitializer>());
        return services;
    }

    private sealed class NotatoInitializer : IMauiInitializeService
    {
        public void Initialize(IServiceProvider services) => Feedback.Current = services.GetRequiredService<NotatoController>();
    }
}
