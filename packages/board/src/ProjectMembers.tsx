import { useCallback, useEffect, useState } from "react";
import { json, request } from "./api.ts";

interface Access {
    owner: { kind: string; id: string };
    members: Record<string, string>;
}
export function ProjectMembers({ project }: { project: string }) {
    const [access, setAccess] = useState<Access | null>(null);
    const [labels, setLabels] = useState<Record<string, { name: string }>>({});
    const [manage, setManage] = useState(false);
    const [username, setUsername] = useState("");
    const [error, setError] = useState("");
    const path = "/projects/" + encodeURIComponent(project) + "/members";
    const load = useCallback(
        () =>
            request<{
                access: Access | null;
                canManage: boolean;
                labels?: Record<string, { name: string }>;
            }>(path).then((data) => {
                setAccess(data.access);
                setManage(data.canManage);
                setLabels(data.labels ?? {});
            }),
        [path]
    );
    useEffect(() => {
        load().catch((e: Error) => setError(e.message));
    }, [load]);
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Project members</h2>
                <p>Members can see shared feedback. Personal feedback stays with its creator.</p>
            </div>
            <div className="set-body">
                {error ? <p className="error">{error}</p> : null}
                {!access ? (
                    <p className="muted">
                        This existing project follows its workspace’s access rules.
                    </p>
                ) : null}
                {Object.entries(access?.members ?? {}).map(([member, role]) => (
                    <div className="setting-row" key={member}>
                        <span>
                            {labels[member]?.name ?? member} · {role}
                        </span>
                        {manage && role !== "owner" ? (
                            <button
                                type="button"
                                onClick={() => {
                                    request(path + "/" + encodeURIComponent(member), {
                                        method: "DELETE",
                                    })
                                        .then(load)
                                        .catch((e: Error) => setError(e.message));
                                }}
                            >
                                Remove
                            </button>
                        ) : null}
                    </div>
                ))}
                {manage ? (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            request(path, json("POST", { username }))
                                .then(() => {
                                    setUsername("");
                                    return load();
                                })
                                .catch((e: Error) => setError(e.message));
                        }}
                    >
                        <label className="field">
                            Collaborator account
                            <input
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                required
                                placeholder="Username or workspace email"
                            />
                        </label>
                        <button type="submit">Add collaborator</button>
                    </form>
                ) : null}
                {manage && access ? (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            const data = new FormData(event.currentTarget);
                            request(
                                "/projects/" + encodeURIComponent(project) + "/owner",
                                json("PATCH", { username: data.get("owner") })
                            )
                                .then(load)
                                .catch((e: Error) => setError(e.message));
                        }}
                    >
                        <label className="field">
                            Transfer ownership
                            <select name="owner" required defaultValue="">
                                <option value="">Choose a project member</option>
                                {Object.entries(access.members)
                                    .filter(([, role]) => role !== "owner")
                                    .map(([member]) => (
                                        <option key={member} value={member}>
                                            {labels[member]?.name ?? member}
                                        </option>
                                    ))}
                            </select>
                        </label>
                        <button type="submit">Transfer project ownership</button>
                    </form>
                ) : null}
            </div>
        </section>
    );
}
