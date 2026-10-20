import { useId } from "react";
import type { WorkflowCondition, WorkflowConditions } from "../../server/src/plugins/conditions.ts";

function newCondition(field: WorkflowCondition["field"]): WorkflowCondition {
    switch (field) {
        case "visibility":
            return { field, value: "shared" };
        case "tag":
            return { field, value: "" };
        case "severity":
            return { field, value: "blocker" };
        case "intent":
            return { field, value: "fix" };
    }
}
const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export function conditionText(rule: WorkflowCondition, own = true) {
    switch (rule.field) {
        case "visibility":
            return `Visibility is ${rule.value === "shared" ? "Shared" : own ? "My personal" : "Creator’s personal"}`;
        case "tag":
            return `Has tag #${rule.value.trim().replace(/^#/, "").toLowerCase() || "…"}`;
        case "severity":
            return `Severity is ${capitalise(rule.value)}`;
        case "intent":
            return `Feedback type is ${capitalise(rule.value)}`;
    }
}
export function WorkflowRuleSummary({
    conditions,
    own = true,
}: {
    conditions: WorkflowConditions;
    own?: boolean;
}) {
    const join = conditions.match === "all" ? "AND" : "OR";
    return (
        <div className="workflow-rule-summary">
            <strong>
                Match {conditions.match === "all" ? "all conditions" : "any condition"} ({join})
            </strong>
            <ol>
                {conditions.rules.map((rule, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Read-only ordered text has no per-row state.
                    <li key={`${index}-${rule.field}`}>
                        {index > 0 && <span className="condition-join">{join} </span>}
                        {conditionText(rule, own)}
                    </li>
                ))}
            </ol>
        </div>
    );
}

export function WorkflowRules({
    value,
    onChange,
    busy,
}: {
    value: WorkflowConditions;
    onChange(value: WorkflowConditions): void;
    busy: boolean;
}) {
    const id = useId();
    const changeRule = (index: number, rule: WorkflowCondition) =>
        onChange({
            ...value,
            rules: value.rules.map((current, i) => (i === index ? rule : current)),
        });
    return (
        <fieldset className="workflow-rules">
            <legend>If</legend>
            <label>
                Match
                <select
                    value={value.match}
                    disabled={busy}
                    onChange={(e) =>
                        onChange({ ...value, match: e.target.value as WorkflowConditions["match"] })
                    }
                >
                    <option value="all">All conditions (AND)</option>
                    <option value="any">Any condition (OR)</option>
                </select>
            </label>
            <p className="muted small">AND requires every condition. OR requires at least one.</p>
            {value.rules.map((rule, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Ordered fields are fully controlled; rows have no local state.
                <div className="workflow-condition" key={`${index}-${rule.field}`}>
                    {index > 0 && (
                        <strong className="condition-join">
                            {value.match === "all" ? "AND" : "OR"}
                        </strong>
                    )}
                    <div className="workflow-condition-fields">
                        <label>
                            Condition {index + 1}
                            <select
                                aria-label={`Condition ${index + 1} field`}
                                value={rule.field}
                                disabled={busy}
                                onChange={(e) =>
                                    changeRule(
                                        index,
                                        newCondition(e.target.value as WorkflowCondition["field"])
                                    )
                                }
                            >
                                <option value="visibility">Visibility is</option>
                                <option value="tag">Has tag</option>
                                <option value="severity">Severity is</option>
                                <option value="intent">Feedback type is</option>
                            </select>
                        </label>
                        <label htmlFor={`${id}-${index}-value`}>
                            Value
                            {rule.field === "tag" ? (
                                <input
                                    id={`${id}-${index}-value`}
                                    aria-label={`Condition ${index + 1} tag`}
                                    value={rule.value}
                                    required
                                    placeholder="#xyz"
                                    pattern="#?[A-Za-z0-9][A-Za-z0-9_-]{0,47}"
                                    maxLength={49}
                                    disabled={busy}
                                    onChange={(e) =>
                                        changeRule(index, { field: "tag", value: e.target.value })
                                    }
                                />
                            ) : (
                                <select
                                    id={`${id}-${index}-value`}
                                    aria-label={`Condition ${index + 1} value`}
                                    value={rule.value}
                                    disabled={busy}
                                    onChange={(e) =>
                                        changeRule(index, {
                                            ...rule,
                                            value: e.target.value,
                                        } as WorkflowCondition)
                                    }
                                >
                                    {rule.field === "visibility" ? (
                                        <>
                                            <option value="shared">Shared</option>
                                            <option value="personal">My personal</option>
                                        </>
                                    ) : (
                                        (rule.field === "severity"
                                            ? ["blocker", "major", "minor", "nit"]
                                            : ["fix", "change", "question", "approve", "variants"]
                                        ).map((option) => (
                                            <option key={option} value={option}>
                                                {capitalise(option)}
                                            </option>
                                        ))
                                    )}
                                </select>
                            )}
                        </label>
                        <button
                            type="button"
                            aria-label={`Remove condition ${index + 1}`}
                            disabled={busy || value.rules.length === 1}
                            onClick={() =>
                                onChange({
                                    ...value,
                                    rules: value.rules.filter((_, i) => i !== index),
                                })
                            }
                        >
                            Remove
                        </button>
                    </div>
                </div>
            ))}
            <button
                type="button"
                disabled={busy || value.rules.length >= 8}
                onClick={() => onChange({ ...value, rules: [...value.rules, newCondition("tag")] })}
            >
                Add condition
            </button>
            <p className="muted small">
                Tags match complete hashtags in the annotation’s comment, ignoring case.
            </p>
        </fieldset>
    );
}
