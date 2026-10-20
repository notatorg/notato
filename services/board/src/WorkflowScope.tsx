import {
    type WorkflowConditions,
    workflowConditions,
    workflowTags,
} from "../../server/src/plugins/conditions.ts";
import type { Workflow } from "../../server/src/plugins/model.ts";
import { WorkflowRuleSummary } from "./WorkflowRules.tsx";

/** Show every condition, including explicit consent to route tagged personal annotations. */
export function WorkflowScope({
    project,
    severity,
    intent,
    tag,
    includePersonal,
    own = true,
    destination,
    conditions,
}: {
    project?: string;
    severity?: Workflow["severity"];
    intent?: Workflow["intent"];
    tag?: string;
    includePersonal?: boolean;
    own?: boolean;
    destination?: string;
    conditions?: WorkflowConditions;
}) {
    const criteria = { conditions, includePersonal, tag, severity, intent };
    const group = workflowConditions(criteria);
    const allowsVisibility = (visibility: "shared" | "personal") => {
        const matches = (rule: WorkflowConditions["rules"][number]) =>
            rule.field !== "visibility" || rule.value === visibility;
        return group.match === "all" ? group.rules.every(matches) : group.rules.some(matches);
    };
    const shared = allowsVisibility("shared");
    const personal =
        includePersonal && allowsVisibility("personal") && workflowTags(criteria).length > 0;
    const personalLabel = `${own ? "my" : "creator’s"} tagged personal annotations`;
    return (
        <fieldset className="workflow-scope">
            <legend>Applies to</legend>
            <dl>
                <div>
                    <dt>Destination</dt>
                    <dd>{destination ?? "Choose a saved action"}</dd>
                </div>
                <div>
                    <dt>Audience</dt>
                    <dd>
                        <strong>
                            {shared && personal
                                ? `Shared + ${personalLabel}`
                                : personal
                                  ? `${own ? "My" : "Creator’s"} tagged personal annotations only`
                                  : shared
                                    ? "Shared annotations only"
                                    : "No matching audience"}
                        </strong>
                        <span>
                            {personal
                                ? "Personal annotations stay personal in Notato. Their content is sent to the saved action’s destination."
                                : !shared
                                  ? "Check the visibility conditions and personal annotation opt-in."
                                  : includePersonal && !allowsVisibility("personal")
                                    ? "The AND conditions require Shared, so personal annotations do not match."
                                    : "Personal annotations are excluded."}
                        </span>
                    </dd>
                </div>
                <div>
                    <dt>Project</dt>
                    <dd>{project ?? "Choose a saved action to see its project"}</dd>
                </div>
            </dl>
            <WorkflowRuleSummary conditions={group} own={own} />
        </fieldset>
    );
}
