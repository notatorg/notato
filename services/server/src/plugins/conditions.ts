import { type Annotation, Intent, Severity } from "@notato/schema";
import { z } from "zod";

export const WorkflowTag = z
    .string()
    .trim()
    .transform((tag) => tag.replace(/^#/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/));
export const WorkflowCondition = z.discriminatedUnion("field", [
    z.object({ field: z.literal("visibility"), value: z.enum(["shared", "personal"]) }).strict(),
    z.object({ field: z.literal("tag"), value: WorkflowTag }).strict(),
    z.object({ field: z.literal("severity"), value: Severity }).strict(),
    z.object({ field: z.literal("intent"), value: Intent }).strict(),
]);
export const WorkflowConditions = z
    .object({
        match: z.enum(["all", "any"]),
        rules: z.array(WorkflowCondition).min(1).max(8),
    })
    .strict();
export type WorkflowCondition = z.infer<typeof WorkflowCondition>;
export type WorkflowConditions = z.infer<typeof WorkflowConditions>;
export interface WorkflowCriteria {
    conditions?: WorkflowConditions;
    includePersonal?: boolean;
    tag?: string;
    severity?: Annotation["severity"];
    intent?: Annotation["intent"];
}

/** Legacy filters retain their existing AND semantics until a person edits them. */
export function workflowConditions(w: WorkflowCriteria): WorkflowConditions {
    if (w.conditions) return w.conditions;
    const rules: WorkflowCondition[] = [];
    if (!w.includePersonal) rules.push({ field: "visibility", value: "shared" });
    if (w.tag) rules.push({ field: "tag", value: w.tag });
    if (w.severity) rules.push({ field: "severity", value: w.severity });
    if (w.intent) rules.push({ field: "intent", value: w.intent });
    return { match: "all", rules };
}
export const workflowTags = (w: WorkflowCriteria) =>
    workflowConditions(w)
        .rules.filter(
            (rule): rule is Extract<WorkflowCondition, { field: "tag" }> => rule.field === "tag"
        )
        .map((rule) => rule.value.trim().replace(/^#/, "").toLowerCase())
        .filter(Boolean);

/** A complete hashtag in the comment, excluding captured page text, URLs and thread replies. */
export const tagPattern = (tag: string) => `(^|[\\s(\\[{])#${tag}($|[^a-zA-Z0-9_-])`;
export function hasWorkflowTag(note: Annotation, tag: string) {
    return new RegExp(tagPattern(tag), "i").test(note.comment);
}
export function conditionsMatch(w: WorkflowCriteria, note: Annotation) {
    const group = workflowConditions(w);
    const matches = (rule: WorkflowCondition) =>
        rule.field === "tag"
            ? hasWorkflowTag(note, rule.value)
            : rule.field === "visibility"
              ? (note.visibility ?? "shared") === rule.value
              : note[rule.field] === rule.value;
    return group.match === "all" ? group.rules.every(matches) : group.rules.some(matches);
}

/** Column names and operators are fixed; every condition value is bound as a SQL parameter. */
export function conditionsSql(w: WorkflowCriteria, bind: (value: string) => string) {
    const group = workflowConditions(w);
    if (!group.rules.length) return "TRUE";
    const rules = group.rules.map((rule) => {
        if (rule.field === "tag")
            return `json::jsonb->>'comment' ~* ${bind(tagPattern(rule.value))}`;
        if (rule.field === "visibility")
            return `COALESCE(json::jsonb->>'visibility','shared')=${bind(rule.value)}`;
        return `${rule.field}=${bind(rule.value)}`;
    });
    return `(${rules.join(group.match === "all" ? " AND " : " OR ")})`;
}
