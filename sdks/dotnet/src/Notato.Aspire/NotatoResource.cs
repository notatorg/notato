namespace Aspire.Hosting.ApplicationModel;

/// <summary>
/// Notato running on this machine (<c>notato start</c>): the board, the server an app's notes go to, and MCP for coding
/// agents at <c>/mcp</c>. Add it with <c>AddNotato</c>, and turn it on in an app with <c>WithReference</c>.
/// </summary>
public sealed class NotatoResource(string name, string command, string workingDirectory)
    : ExecutableResource(name, command, workingDirectory)
{
    internal const string EndpointName = "http";

    private EndpointReference? _endpoint;

    /// <summary>Where Notato listens: the board, the API an app posts its notes to, and MCP.</summary>
    public EndpointReference Endpoint => _endpoint ??= new EndpointReference(this, EndpointName);

    /// <summary>The server's address, such as <c>http://localhost:4747</c>: what an app is given as its Notato server.</summary>
    public ReferenceExpression ServerUrl => ReferenceExpression.Create($"{Endpoint.Property(EndpointProperty.Url)}");

    /// <summary>The address coding agents connect to, such as <c>http://localhost:4747/mcp</c>.</summary>
    public ReferenceExpression McpUrl => ReferenceExpression.Create($"{Endpoint.Property(EndpointProperty.Url)}/mcp");
}
