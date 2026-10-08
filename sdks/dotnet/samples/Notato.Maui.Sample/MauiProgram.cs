using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Notato.Maui;
using Notato.Maui.Sample.Views;
using System.Reflection;

namespace Notato.Maui.Sample;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        MauiAppBuilder builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
            });

        // appsettings.json is embedded in the app; its "Notato" section configures Notato.
        using Stream? settings = Assembly.GetExecutingAssembly().GetManifestResourceStream("Notato.Maui.Sample.appsettings.json");
        if (settings is not null)
        {
            builder.Configuration.AddJsonStream(settings);
        }
        // And environment variables over it, e.g. Notato__Server=http://localhost:4790 (simctl: SIMCTL_CHILD_Notato__Server).
        builder.Configuration.AddEnvironmentVariables();

#if DEBUG
        builder.Logging.AddDebug();
        // Binds the "Notato" section, then lets code adjust it. Leave this out of a build to ship nothing of Notato.
        builder.UseNotato(options =>
        {
            options.AppName = "Notato MAUI sample";
        });
#endif
#if NOTATO_DEVFLOW
        Microsoft.Maui.DevFlow.Agent.AgentServiceExtensions.AddMauiDevFlowAgent(builder);
#endif

        builder.Services.AddTransient<AccountPage>();
        builder.Services.AddTransient<FeedbackPage>();
        return builder.Build();
    }
}
