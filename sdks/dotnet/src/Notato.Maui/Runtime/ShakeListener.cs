using Microsoft.Extensions.Logging;
using Microsoft.Maui.Devices.Sensors;

namespace Notato.Maui.Runtime;

/// <summary>
/// Listens for shakes on the accelerometer the app may be using too. It is started only when nothing is reading it
/// yet, and stopped only if this started it, so the app's own readings carry on either way; a sensor that cannot be
/// started just means no shake.
/// </summary>
internal sealed class ShakeListener(IAccelerometer accelerometer, EventHandler onShake, ILogger logger)
{
    private bool _listening;
    private bool _startedIt;

    public bool Listening => _listening;

    public void Start()
    {
        if (_listening)
        {
            return;
        }

        try
        {
            accelerometer.ShakeDetected += onShake;
            _listening = true;
            if (!accelerometer.IsMonitoring)
            {
                accelerometer.Start(SensorSpeed.Game);
                _startedIt = true;
            }
        }
        catch (Exception error)
        {
            // Unsupported, not allowed, or the app started it a moment ago: its shakes still arrive if it runs.
            logger.LogDebug(error, "Notato could not start the accelerometer to listen for shakes");
        }
    }

    public void Stop()
    {
        if (!_listening)
        {
            return;
        }

        _listening = false;
        try
        {
            accelerometer.ShakeDetected -= onShake;
            if (_startedIt && accelerometer.IsMonitoring)
            {
                accelerometer.Stop();
            }
        }
        catch (Exception error)
        {
            logger.LogDebug(error, "Notato could not stop the accelerometer");
        }
        finally
        {
            _startedIt = false;
        }
    }
}
