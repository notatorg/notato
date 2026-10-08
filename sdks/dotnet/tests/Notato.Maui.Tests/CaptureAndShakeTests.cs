using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Maui.Devices.Sensors;
using Notato.Maui.Native;
using Notato.Maui.Runtime;

namespace Notato.Maui.Tests;

/// <summary>What Notato shares with the app: its window while capturing, and the accelerometer.</summary>
public class CaptureAndShakeTests
{
    [Fact]
    public void The_overlay_shows_again_when_the_last_of_overlapping_captures_ends()
    {
        CaptureHiding hiding = new();
        hiding.BeginCapture();
        hiding.BeginCapture();
        hiding.EndCapture();
        Assert.True(hiding.Capturing);
        hiding.EndCapture();
        Assert.False(hiding.Capturing);
        Assert.True(hiding.Wanted);
    }

    [Fact]
    public void An_overlay_hidden_on_purpose_stays_hidden_after_a_capture()
    {
        CaptureHiding hiding = new();
        hiding.BeginCapture();
        hiding.Wanted = false;
        hiding.EndCapture();
        hiding.EndCapture();
        Assert.False(hiding.Capturing);
        Assert.False(hiding.Wanted);
    }

    /// <summary>A screen's bitmap that counts how often it is let go.</summary>
    private sealed class FakeImage : Microsoft.Maui.Graphics.IImage
    {
        public int Disposed { get; private set; }
        public float Width => 1206;
        public float Height => 2622;
        public void Dispose() => Disposed++;
        public Microsoft.Maui.Graphics.IImage Downsize(float maxWidthOrHeight, bool disposeOriginal = false) => throw new NotSupportedException();
        public Microsoft.Maui.Graphics.IImage Downsize(float maxWidth, float maxHeight, bool disposeOriginal = false) => throw new NotSupportedException();
        public Microsoft.Maui.Graphics.IImage Resize(float width, float height, Microsoft.Maui.Graphics.ResizeMode resizeMode = Microsoft.Maui.Graphics.ResizeMode.Fit, bool disposeOriginal = false) => throw new NotSupportedException();
        public void Save(Stream stream, Microsoft.Maui.Graphics.ImageFormat format = Microsoft.Maui.Graphics.ImageFormat.Png, float quality = 1) => throw new NotSupportedException();
        public Task SaveAsync(Stream stream, Microsoft.Maui.Graphics.ImageFormat format = Microsoft.Maui.Graphics.ImageFormat.Png, float quality = 1) => throw new NotSupportedException();
        public Microsoft.Maui.Graphics.IImage ToPlatformImage() => this;
        public void Draw(Microsoft.Maui.Graphics.ICanvas canvas, Microsoft.Maui.Graphics.RectF dirtyRect) => throw new NotSupportedException();
    }

    private static CapturedScreen Screen(FakeImage image) => new(image, 1206, 2622, 3, []);

    [Fact]
    public void A_selections_picture_goes_with_it_once_and_a_note_that_takes_it_has_it_alone()
    {
        FakeImage cancelled = new();
        SelectionState selection = new([], Screen(cancelled));
        selection.Dispose();
        selection.Dispose();
        Assert.Equal(1, cancelled.Disposed);
        Assert.Null(selection.Screen);

        // Taken by the note being made: the selection no longer lets it go; the note does, once drawn.
        FakeImage taken = new();
        SelectionState sent = new([], Screen(taken));
        CapturedScreen? screen = sent.TakeScreen();
        sent.Dispose();
        Assert.Equal(0, taken.Disposed);
        screen!.Dispose();
        screen.Dispose();
        Assert.Equal(1, taken.Disposed);
    }

    private sealed class FakeAccelerometer : IAccelerometer
    {
        public bool IsSupported => true;
        public bool IsMonitoring { get; set; }
        public bool ThrowOnStart { get; set; }
        public int Starts { get; private set; }
        public int Stops { get; private set; }
        public int ShakeListeners => ShakeDetected?.GetInvocationList().Length ?? 0;

        public event EventHandler<AccelerometerChangedEventArgs>? ReadingChanged;
        public event EventHandler? ShakeDetected;

        public void Start(SensorSpeed sensorSpeed)
        {
            if (ThrowOnStart || IsMonitoring)
            {
                throw new InvalidOperationException("Accelerometer has already been started.");
            }

            Starts++;
            IsMonitoring = true;
        }

        public void Stop()
        {
            Stops++;
            IsMonitoring = false;
        }

        public void Shake() => ShakeDetected?.Invoke(this, EventArgs.Empty);

        public void Read() => ReadingChanged?.Invoke(this, null!);
    }

    [Fact]
    public void An_accelerometer_the_app_already_reads_is_shared_and_left_running()
    {
        FakeAccelerometer sensor = new() { IsMonitoring = true };
        int shakes = 0;
        ShakeListener listener = new(sensor, (_, _) => shakes++, NullLogger.Instance);

        listener.Start();
        sensor.Shake();
        listener.Stop();

        Assert.Equal(1, shakes);
        Assert.Equal(0, sensor.Starts);
        Assert.Equal(0, sensor.Stops);
        Assert.True(sensor.IsMonitoring);
        Assert.Equal(0, sensor.ShakeListeners);
    }

    [Fact]
    public void An_accelerometer_nothing_was_reading_is_started_and_stopped_again()
    {
        FakeAccelerometer sensor = new();
        ShakeListener listener = new(sensor, (_, _) => { }, NullLogger.Instance);

        listener.Start();
        listener.Start();
        Assert.Equal(1, sensor.Starts);
        Assert.Equal(1, sensor.ShakeListeners);

        listener.Stop();
        listener.Stop();
        Assert.Equal(1, sensor.Stops);
        Assert.False(sensor.IsMonitoring);
    }

    [Fact]
    public void An_accelerometer_that_will_not_start_is_no_error()
    {
        FakeAccelerometer sensor = new() { ThrowOnStart = true };
        ShakeListener listener = new(sensor, (_, _) => { }, NullLogger.Instance);

        listener.Start();
        listener.Stop();

        Assert.Equal(0, sensor.Stops);
        Assert.Equal(0, sensor.ShakeListeners);
    }
}
