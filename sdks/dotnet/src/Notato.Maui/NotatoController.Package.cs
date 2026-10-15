using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.ApplicationModel.DataTransfer;
using Microsoft.Maui.Storage;
using Notato.Maui.Net;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;

namespace Notato.Maui;

// Test mode: the notes made on this device, packaged as the bundle zip notato_import_bundle reads, shared, and uploaded
// when a server is set.
internal sealed partial class NotatoController
{
    public async Task<string> PackageAsync(bool upload = true, CancellationToken cancellationToken = default)
    {
        (string path, _) = await PackageToFileAsync(cancellationToken);
        if (upload && Uploads)
        {
            await UploadPackageAsync(path, cancellationToken);
        }

        return path;
    }

    /// <summary>Whether a package goes to the server too: there is one, and the app's token may do more than send notes.</summary>
    private bool Uploads => Server is not null && !CaptureOnly;

    /// <summary>The menu's Package and share: packaged, uploaded when there is a server, then the share sheet.</summary>
    internal async Task PackageFromMenuAsync(OverlaySession session)
    {
        try
        {
            string? uploadProblem = null;
            (string path, bool screenshots) = await PackageToFileAsync(CancellationToken.None);
            if (Uploads)
            {
                try
                {
                    await UploadPackageAsync(path, CancellationToken.None);
                }
                catch (NotatoServerException error)
                {
                    // The zip is written: it is shared all the same.
                    uploadProblem = error.Message;
                }
            }

            await Share.Default.RequestAsync(new ShareFileRequest { Title = "Notato feedback", File = new ShareFile(path, "application/zip") });
            string done = uploadProblem is null
                ? Uploads ? "Packaged and uploaded." : "Packaged. Send the zip to the developer."
                : $"Packaged, but not uploaded: {uploadProblem}";
            session.View.Toast(screenshots ? done : done + " Without screenshots: the server does not take them.");
        }
        catch (Exception error)
        {
            session.View.Toast(error.Message);
        }
    }

    /// <summary>Test mode: forget the notes kept on this device, once they have been packaged.</summary>
    internal async Task ClearLocalAsync()
    {
        _records.RemoveAll(r => r.Pending);
        if (_local is not null)
        {
            await _local.ClearAsync();
        }

        RaiseChanged();
    }

    /// <summary>
    /// Writes this device's notes to a bundle zip in the app's cache, off the main thread, and returns its path. With a
    /// server set, the screenshots go in only when it says it takes them: they may have been taken while it did, but a
    /// package is shared by hand, so it follows what the server says now.
    /// </summary>
    private async Task<(string Path, bool Screenshots)> PackageToFileAsync(CancellationToken ct)
    {
        await AskBrieflyAsync();
        (List<LocalAnnotation> mine, bool screenshots) = await MainThread.InvokeOnMainThreadAsync(() =>
        {
            bool screenshots = Server is null || _serverScreenshots == true;
            return (_records
                .Where(r => r.Pending || (Mode == NotatoMode.Test && r.Mine))
                .Select(r => new LocalAnnotation(r.Annotation, (screenshots ? r.Assets : null) ?? new Dictionary<string, string>()))
                .ToList(), screenshots);
        });
        if (mine.Count == 0)
        {
            throw new InvalidOperationException("Nothing to package yet: make at least one note.");
        }

        string path = await BundleWriter.WriteAsync(mine, Options.Project, AuthorName, AppContextInfo.AppName(Options), AppContextInfo.AppVersion(Options), FileSystem.Current.CacheDirectory, ct);
        return (path, screenshots);
    }

    /// <summary>
    /// Uploads a packaged zip from its file. One over the server's limit is not sent at all: the server would refuse
    /// it after the whole of it had gone.
    /// </summary>
    private async Task UploadPackageAsync(string path, CancellationToken ct)
    {
        long size = new FileInfo(path).Length;
        if (size > BundleWriter.ServerLimit)
        {
            throw new NotatoServerException($"the package is {MenuText.Megabytes(size)}, over the server's {MenuText.Megabytes(BundleWriter.ServerLimit)} limit. Share the zip instead.", 413);
        }

        string server = Server ?? throw new InvalidOperationException("No server is set to upload the package to.");
        NotatoClient uploader = new(_http, server, Options.TokenFor(server));
        await uploader.UploadBundleAsync(Options.Project, path, ct);
    }
}
