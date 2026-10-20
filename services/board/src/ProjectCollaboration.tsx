import { useEffect, useState } from "react";
import { getMe, json, type Me, request } from "./api.ts";

export function ProjectCollaboration({ project }: { project: string }) {
    const [email, setEmail] = useState("");
    const [link, setLink] = useState("");
    const [error, setError] = useState("");
    const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
    const [target, setTarget] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        getMe().then(
            (me) =>
                setWorkspaces(
                    ((me as Me).workspaces ?? []).filter((workspace) => workspace.role !== "member")
                ),
            () => {}
        );
    }, []);
    const run = async (work: () => Promise<unknown>) => {
        setBusy(true);
        setError("");
        try {
            await work();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save.");
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Invite or move a project</h2>
                <p>Keep this project ID and private feedback as your team grows.</p>
            </div>
            <div className="set-body">
                {error ? <p className="error">{error}</p> : null}
                <form
                    className="settings-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void run(async () => {
                            const data = await request<{ url: string }>(
                                "/projects/" + encodeURIComponent(project) + "/invitations",
                                json("POST", { email })
                            );
                            setLink(data.url);
                        });
                    }}
                >
                    <label className="field">
                        Invite a developer or tester by email
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </label>
                    <button type="submit" disabled={busy}>
                        Create project invitation
                    </button>
                </form>
                {link ? (
                    <label className="field">
                        Invitation link
                        <input value={link} readOnly onFocus={(e) => e.target.select()} />
                    </label>
                ) : null}
                <form
                    className="settings-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void run(async () => {
                            await request(
                                "/projects/" + encodeURIComponent(project) + "/transfer",
                                json("POST", { workspaceId: target })
                            );
                            window.location.hash = "#/";
                            window.location.reload();
                        });
                    }}
                >
                    <label className="field">
                        Move to a workspace you manage
                        <select required value={target} onChange={(e) => setTarget(e.target.value)}>
                            <option value="">Choose a workspace</option>
                            {workspaces.map((workspace) => (
                                <option key={workspace.id} value={workspace.id}>
                                    {workspace.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className="muted">
                        The ID, sessions and feedback stay intact. Personal feedback remains
                        private. App and agent credentials are revoked; plugin actions are archived
                        and workflows stop until configured in the destination workspace.
                        Collaborators need membership there.
                    </p>
                    <button type="submit" disabled={busy || !target}>
                        Move project and revoke old connections
                    </button>
                </form>
            </div>
        </section>
    );
}
