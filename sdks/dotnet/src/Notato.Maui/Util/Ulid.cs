using System.Numerics;
using System.Security.Cryptography;

namespace Notato.Maui.Util;

/// <summary>Universally unique, lexicographically sortable ids: 48 bits of milliseconds and 80 random bits, in Crockford base32.</summary>
internal static class Ulid
{
    private const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    public static string New() => New(DateTimeOffset.UtcNow);

    public static string New(DateTimeOffset at)
    {
        Span<byte> bytes = stackalloc byte[16];
        ulong ms = (ulong)at.ToUnixTimeMilliseconds();
        for (int i = 5; i >= 0; i--)
        {
            bytes[i] = (byte)(ms & 0xFF);
            ms >>= 8;
        }
        RandomNumberGenerator.Fill(bytes[6..]);
        return Encode(bytes);
    }

    private static string Encode(ReadOnlySpan<byte> bytes)
    {
        // 128 bits as 26 characters of 5 bits each, the first carrying only the top 3 bits.
        BigInteger value = new(bytes, isUnsigned: true, isBigEndian: true);
        Span<char> chars = stackalloc char[26];
        for (int i = 25; i >= 0; i--)
        {
            chars[i] = Alphabet[(int)(value & 31)];
            value >>= 5;
        }
        return new string(chars);
    }
}
